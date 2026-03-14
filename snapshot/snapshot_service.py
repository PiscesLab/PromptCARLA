"""
CARLA Snapshot Service
Fixed for WebSocket support, Frontend Health Checks, and Map Visualization Data
"""

import os
import asyncio
import time
import json
import io
import base64
import logging
import numpy as np
from typing import Dict, List, Optional, Set
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from PIL import Image

import carla
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# ===================== 1. Configuration & Logging =====================

load_dotenv()

CARLA_HOST = os.getenv("CARLA_HOST", "localhost")
CARLA_PORT = int(os.getenv("CARLA_PORT", "2000"))
CARLA_TIMEOUT = float(os.getenv("CARLA_TIMEOUT", "30.0"))

LISTENING_PORT = int(os.getenv("SNAPSHOT_PORT", "8000"))
SNAPSHOT_INTERVAL = float(os.getenv("SNAPSHOT_INTERVAL", "0.05"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("snapshot_service")

# ===================== 2. State & Helpers =====================

class SimulationState:
    def __init__(self):
        self.client: Optional[carla.Client] = None
        self.world: Optional[carla.World] = None
        self.blueprint_library = None
        self.current_snapshot: Dict = {}
        self.sensor_data: Dict[int, Dict] = {}
        self.active_sensors: Dict[int, List] = {}
        self.tracked_actors: Set[int] = set()
        self.collision_count = 0
        self.connections: Set[WebSocket] = set()

state = SimulationState()

def on_camera(data, vehicle_id: int):
    array = np.frombuffer(data.raw_data, dtype=np.uint8)
    array = np.reshape(array, (data.height, data.width, 4))
    array = array[:, :, :3] 
    
    img = Image.fromarray(array)
    byte_io = io.BytesIO()
    img.save(byte_io, 'JPEG', quality=70)
    encoded_img = base64.b64encode(byte_io.getvalue()).decode('utf-8')
    
    if vehicle_id not in state.sensor_data:
        state.sensor_data[vehicle_id] = {}
    state.sensor_data[vehicle_id]["front_view"] = {
        "data": encoded_img,
        "timestamp": time.time(),
        "type": "rgb"
    }

def attach_sensors(vehicle):
    vid = vehicle.id
    if vid in state.active_sensors: return
    try:
        bp = state.blueprint_library.find('sensor.camera.rgb')
        bp.set_attribute('image_size_x', '640')
        bp.set_attribute('image_size_y', '480')
        bp.set_attribute('sensor_tick', str(SNAPSHOT_INTERVAL))
        
        transform = carla.Transform(carla.Location(x=2.0, z=1.5))
        camera = state.world.spawn_actor(bp, transform, attach_to=vehicle)
        camera.listen(lambda data: on_camera(data, vid))
        
        state.active_sensors[vid] = [camera]
        state.tracked_actors.add(vid)
    except Exception as e:
        logger.error(f"Failed to attach sensor to vehicle {vid}: {e}")

def extract_vehicle_data(v) -> Dict:
    loc = v.get_location()
    rot = v.get_transform().rotation
    vel = v.get_velocity()
    speed = 3.6 * np.sqrt(vel.x**2 + vel.y**2 + vel.z**2)
    return {
        "id": v.id,
        "type": v.type_id,
        "position": {"x": loc.x, "y": loc.y, "z": loc.z},
        "rotation": {"yaw": rot.yaw, "pitch": rot.pitch, "roll": rot.roll},
        "velocity": {"speed_kmh": speed},
        "autopilot_enabled": v.get_autopilot_enabled() if hasattr(v, 'get_autopilot_enabled') else True
    }

def extract_light_data(l) -> Dict:
    loc = l.get_location()
    # Map CARLA states to frontend strings
    state_map = {
        carla.TrafficLightState.Red: "red",
        carla.TrafficLightState.Yellow: "yellow",
        carla.TrafficLightState.Green: "green",
        carla.TrafficLightState.Off: "off",
        carla.TrafficLightState.Unknown: "unknown"
    }
    return {
        "id": l.id,
        "position": {"x": loc.x, "y": loc.y, "z": loc.z},
        "state": state_map.get(l.state, "unknown")
    }

# ===================== 3. Core Loop =====================

async def update_snapshots():
    while True:
        try:
            if not state.world:
                logger.info(f"Connecting to CARLA at {CARLA_HOST}:{CARLA_PORT}")
                state.client = carla.Client(CARLA_HOST, CARLA_PORT)
                state.client.set_timeout(CARLA_TIMEOUT)
                state.world = state.client.get_world()
                state.blueprint_library = state.world.get_blueprint_library()
                logger.info("Connected successfully.")

            actors = state.world.get_actors()
            vehicles = actors.filter("vehicle.*")
            pedestrians = actors.filter("walker.pedestrian.*")
            lights = actors.filter("traffic.traffic_light")
            
            for v in vehicles:
                if v.id not in state.tracked_actors:
                    attach_sensors(v)

            v_list = [extract_vehicle_data(v) for v in vehicles]
            p_list = [{"id": p.id, "position": {"x": p.get_location().x, "y": p.get_location().y, "z": p.get_location().z}, "velocity": {"speed": 1.0}, "heading": 0} for p in pedestrians]
            l_list = [extract_light_data(l) for l in lights]

            # Calculate Density (ratio of vehicles to an arbitrary map area factor)
            density = (len(v_list) / 50.0) * 10.0 

            metrics = {
                "total_vehicles": len(v_list),
                "total_pedestrians": len(p_list),
                "average_speed_kmh": np.mean([v["velocity"]["speed_kmh"] for v in v_list]) if v_list else 0.0,
                "max_speed_kmh": np.max([v["velocity"]["speed_kmh"] for v in v_list]) if v_list else 0.0,
                "traffic_density": min(density, 10.0),
                "total_collisions": state.collision_count
            }
            
            snapshot = {
                "timestamp": time.time(),
                "vehicles": v_list,
                "pedestrians": p_list,
                "traffic_lights": l_list,
                "metrics": metrics
            }

            state.current_snapshot = snapshot
            
            if state.connections:
                msg = json.dumps(snapshot)
                disconnected = set()
                for ws in state.connections:
                    try:
                        await ws.send_text(msg)
                    except Exception:
                        disconnected.add(ws)
                state.connections -= disconnected

            await asyncio.sleep(SNAPSHOT_INTERVAL)

        except Exception as e:
            logger.error(f"CARLA Sync Error: {e}")
            state.world = None 
            await asyncio.sleep(2)

# ===================== 4. API Endpoints =====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(update_snapshots())
    yield
    task.cancel()
    for sensors in state.active_sensors.values():
        for s in sensors:
            try: s.destroy()
            except: pass

app = FastAPI(title="CARLA Snapshot Service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health_check():
    return {
        "status": "online",
        "carla_connected": state.world is not None,
        "timestamp": datetime.utcnow().isoformat()
    }

@app.get("/snapshot")
async def get_snapshot():
    return state.current_snapshot

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    state.connections.add(ws)
    try:
        while True:
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        state.connections.remove(ws)
    except Exception:
        if ws in state.connections:
            state.connections.remove(ws)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=LISTENING_PORT)
