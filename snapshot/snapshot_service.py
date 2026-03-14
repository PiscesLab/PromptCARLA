"""
CARLA Snapshot Service
Fixed for WebSocket support, Frontend Health Checks, Traffic Light Data, and Map Data
"""

import os
import asyncio
import time
import json
import logging
import numpy as np
from typing import Dict, List, Optional, Set
from datetime import datetime
from contextlib import asynccontextmanager
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
        self.tracked_actors: Set[int] = set()
        self.collision_count = 0
        self.connections: Set[WebSocket] = set()
        self.map_data: Optional[Dict] = None  # cached on first fetch

state = SimulationState()

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

def build_map_data(carla_map) -> Dict:
    """
    Build road geometry using dense waypoint sampling rather than the sparse
    topology graph. generate_waypoints() samples every lane at a fixed interval
    which gives enough points to reconstruct actual road shapes on the frontend.

    Each waypoint also carries lane width so the frontend can draw proper road
    polygons instead of just centerlines.
    """
    WAYPOINT_DISTANCE = 2.0  # metres between samples — lower = more detail, more data

    waypoints = carla_map.generate_waypoints(WAYPOINT_DISTANCE)

    # Group waypoints by (road_id, lane_id) so the frontend can draw each lane
    # as a polyline rather than a cloud of disconnected points.
    lanes: Dict[str, list] = {}
    for wp in waypoints:
        key = f"{wp.road_id}_{wp.lane_id}"
        if key not in lanes:
            lanes[key] = []
        t = wp.transform
        lanes[key].append({
            "x": t.location.x,
            "y": t.location.y,
            "width": wp.lane_width,
        })

    # Convert to a list for JSON serialisation
    lane_list = [{"points": pts} for pts in lanes.values()]

    spawn_points = carla_map.get_spawn_points()
    spawns = [{"x": sp.location.x, "y": sp.location.y} for sp in spawn_points]

    logger.info(f"Map data: {len(lane_list)} lanes, {len(spawns)} spawn points")

    return {
        "map_name": carla_map.name,
        "lanes": lane_list,
        "spawn_points": spawns,
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
                state.map_data = None  # reset map cache on reconnect
                logger.info("Connected successfully.")

            actors = state.world.get_actors()
            vehicles = actors.filter("vehicle.*")
            pedestrians = actors.filter("walker.pedestrian.*")
            lights = actors.filter("traffic.traffic_light")

            v_list = [extract_vehicle_data(v) for v in vehicles]
            p_list = [{"id": p.id, "position": {"x": p.get_location().x, "y": p.get_location().y, "z": p.get_location().z}, "velocity": {"speed": 1.0}, "heading": 0} for p in pedestrians]
            l_list = [extract_light_data(l) for l in lights]

            metrics = {
                "total_vehicles": len(v_list),
                "total_pedestrians": len(p_list),
                "average_speed_kmh": np.mean([v["velocity"]["speed_kmh"] for v in v_list]) if v_list else 0.0,
                "max_speed_kmh": np.max([v["velocity"]["speed_kmh"] for v in v_list]) if v_list else 0.0,
                "traffic_density": min((len(v_list) / 50.0) * 10.0, 10.0),
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

app = FastAPI(title="CARLA Snapshot Service", lifespan=lifespan)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
async def health_check():
    return {"status": "online", "carla_connected": state.world is not None}

@app.get("/map_data")
async def get_map_data():
    if not state.world:
        raise HTTPException(status_code=503, detail="CARLA not connected")
    # Return cached map data — topology doesn't change during a session
    if not state.map_data:
        carla_map = state.world.get_map()
        state.map_data = build_map_data(carla_map)
        logger.info(f"Map data built: {len(state.map_data['roads'])} road segments")
    return state.map_data

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    state.connections.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        state.connections.remove(ws)
    except Exception:
        if ws in state.connections:
            state.connections.remove(ws)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=LISTENING_PORT)
