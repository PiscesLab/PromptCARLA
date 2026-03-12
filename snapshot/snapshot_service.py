"""
CARLA Snapshot Service

Read-only service that streams live simulation data via WebSocket
and REST endpoints. Does NOT manage traffic or spawn actors --
that's the simulator service's job.

Responsibilities:
- Connect to CARLA (read-only)
- Attach sensors to discovered vehicles
- Stream snapshots via WebSocket
- Serve camera feeds via REST
- Track metrics (collisions, speeds, distances)
"""

import os
import asyncio
import time
import json
import io
import base64
import logging
from typing import Dict, List, Optional, Set
from datetime import datetime
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import carla
import numpy as np
from PIL import Image
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from logging.handlers import RotatingFileHandler


# ===================== Configuration =====================

for _candidate in [Path(__file__).parent / '.env', Path(__file__).parent.parent / '.env']:
    if _candidate.exists():
        load_dotenv(dotenv_path=_candidate)
        break

CARLA_HOST = os.getenv("CARLA_HOST", os.getenv("NODE_IP", "localhost"))
CARLA_PORT = int(os.getenv("CARLA_PORT", "2000"))
CARLA_TIMEOUT = float(os.getenv("CARLA_TIMEOUT", "30.0"))
SNAPSHOT_INTERVAL = float(os.getenv("SNAPSHOT_INTERVAL", "0.05"))
MAX_HISTORY = int(os.getenv("MAX_HISTORY", "100"))
CAMERA_WIDTH = int(os.getenv("CAMERA_WIDTH", "640"))
CAMERA_HEIGHT = int(os.getenv("CAMERA_HEIGHT", "480"))

LOG_DIR = Path(os.getenv("LOG_DIR", "/app/logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)

LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)

_file_handler = RotatingFileHandler(
    LOG_DIR / "snapshot.log", maxBytes=10 * 1024 * 1024, backupCount=5
)
_file_handler.setFormatter(logging.Formatter(LOG_FORMAT))
_file_handler.setLevel(logging.INFO)
logging.getLogger().addHandler(_file_handler)

logger = logging.getLogger("snapshot_service")


# ===================== Simulation State =====================

class SimulationState:
    """Read-only state tracker for the CARLA world."""

    def __init__(self):
        self.client: Optional[carla.Client] = None
        self.world: Optional[carla.World] = None
        self.blueprint_library = None

        # Sync mode tracking
        self.is_synchronous = False
        self.tick_count = 0
        self.last_tick_time = 0.0

        # Current + historical snapshots
        self.current_snapshot: Dict = {
            "timestamp": 0,
            "vehicles": [],
            "pedestrians": [],
            "traffic_lights": [],
            "metrics": {},
        }
        self.snapshot_history: deque = deque(maxlen=MAX_HISTORY)

        # Sensor data keyed by actor ID
        self.sensor_data: Dict[int, Dict] = {}
        self.active_sensors: Dict[int, List] = {}
        self.tracked_actors: Set[int] = set()

        # Metrics
        self.collision_count = 0
        self.total_distance: Dict[int, float] = {}

        # WebSocket clients
        self.connections: List[WebSocket] = []

    def cleanup_destroyed_actors(self):
        """Remove data for actors that no longer exist."""
        if not self.world:
            return

        current_ids = {a.id for a in self.world.get_actors()}
        destroyed = self.tracked_actors - current_ids

        for aid in destroyed:
            if aid in self.active_sensors:
                for sensor in self.active_sensors[aid]:
                    try:
                        sensor.destroy()
                    except RuntimeError:
                        pass
                del self.active_sensors[aid]
            self.sensor_data.pop(aid, None)
            self.total_distance.pop(aid, None)
            self.tracked_actors.discard(aid)

        if destroyed:
            logger.info(f"Cleaned up {len(destroyed)} destroyed actors")


state = SimulationState()


# ===================== Sensor Callbacks =====================

def _safe_float(value) -> float:
    if value is None or (isinstance(value, float) and value != value):
        return 0.0
    return float(value)


def _ensure_sensor_dict(vehicle_id: int) -> Dict:
    if vehicle_id not in state.sensor_data:
        state.sensor_data[vehicle_id] = {}
    return state.sensor_data[vehicle_id]


def on_collision(event, vehicle_id: int):
    state.collision_count += 1
    d = _ensure_sensor_dict(vehicle_id)
    d["last_collision"] = {
        "timestamp": time.time(),
        "other_actor": str(event.other_actor.type_id),
        "impulse": {
            "x": event.normal_impulse.x,
            "y": event.normal_impulse.y,
            "z": event.normal_impulse.z,
        },
    }


def on_lane_invasion(event, vehicle_id: int):
    d = _ensure_sensor_dict(vehicle_id)
    d["lane_invasion"] = {
        "timestamp": time.time(),
        "crossed_lanes": [str(m.type) for m in event.crossed_lane_markings],
    }


def on_imu(data, vehicle_id: int):
    d = _ensure_sensor_dict(vehicle_id)
    d["imu"] = {
        "gyroscope": {
            "x": _safe_float(data.gyroscope.x),
            "y": _safe_float(data.gyroscope.y),
            "z": _safe_float(data.gyroscope.z),
        },
        "accelerometer": {
            "x": _safe_float(data.accelerometer.x),
            "y": _safe_float(data.accelerometer.y),
            "z": _safe_float(data.accelerometer.z),
        },
        "compass": _safe_float(data.compass),
    }


def on_gnss(data, vehicle_id: int):
    d = _ensure_sensor_dict(vehicle_id)
    d["gps"] = {
        "latitude": _safe_float(data.latitude),
        "longitude": _safe_float(data.longitude),
        "altitude": _safe_float(data.altitude),
    }


def on_camera(data, vehicle_id: int, cam_type: str, cam_id: str):
    try:
        if cam_type == "rgb":
            array = np.frombuffer(data.raw_data, dtype=np.uint8)
            image = array.reshape((data.height, data.width, 4))[:, :, :3]
        elif cam_type == "semantic":
            data.convert(carla.ColorConverter.CityScapesPalette)
            array = np.frombuffer(data.raw_data, dtype=np.uint8)
            image = array.reshape((data.height, data.width, 4))[:, :, :3]
        elif cam_type == "depth":
            data.convert(carla.ColorConverter.LogarithmicDepth)
            array = np.frombuffer(data.raw_data, dtype=np.uint8)
            image = array.reshape((data.height, data.width, 4))[:, :, :3]
        else:
            return

        img = Image.fromarray(image)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        encoded = base64.b64encode(buf.getvalue()).decode("utf-8")

        d = _ensure_sensor_dict(vehicle_id)
        if "cameras" not in d:
            d["cameras"] = {}
        d["cameras"][cam_id] = {
            "type": cam_type,
            "data": encoded,
            "timestamp": time.time(),
        }
    except Exception as e:
        logger.error(f"Camera callback error vehicle {vehicle_id}: {e}")


# ===================== Sensor Attachment =====================

def attach_sensors(vehicle):
    """Attach read-only sensors to a vehicle for monitoring."""
    vid = vehicle.id
    if vid in state.active_sensors:
        return

    state.active_sensors[vid] = []
    state.sensor_data[vid] = {}
    bp = state.blueprint_library

    try:
        # IMU
        imu = state.world.spawn_actor(bp.find("sensor.other.imu"), carla.Transform(), attach_to=vehicle)
        state.active_sensors[vid].append(imu)
        imu.listen(lambda data, v=vid: on_imu(data, v))

        # GNSS
        gnss = state.world.spawn_actor(bp.find("sensor.other.gnss"), carla.Transform(), attach_to=vehicle)
        state.active_sensors[vid].append(gnss)
        gnss.listen(lambda data, v=vid: on_gnss(data, v))

        # Collision
        col = state.world.spawn_actor(bp.find("sensor.other.collision"), carla.Transform(), attach_to=vehicle)
        state.active_sensors[vid].append(col)
        col.listen(lambda event, v=vid: on_collision(event, v))

        # Lane invasion
        lane = state.world.spawn_actor(bp.find("sensor.other.lane_invasion"), carla.Transform(), attach_to=vehicle)
        state.active_sensors[vid].append(lane)
        lane.listen(lambda event, v=vid: on_lane_invasion(event, v))

        state.tracked_actors.add(vid)
        logger.info(f"Attached sensors to vehicle {vid}")

    except Exception as e:
        logger.error(f"Failed to attach sensors to vehicle {vid}: {e}")


# ===================== Data Extraction =====================

def extract_vehicle(vehicle) -> Dict:
    vid = vehicle.id
    t = vehicle.get_transform()
    v = vehicle.get_velocity()
    a = vehicle.get_acceleration()
    c = vehicle.get_control()

    speed_mps = (v.x ** 2 + v.y ** 2 + v.z ** 2) ** 0.5
    speed_kmh = speed_mps * 3.6

    if vid not in state.total_distance:
        state.total_distance[vid] = 0.0
    state.total_distance[vid] += speed_mps * SNAPSHOT_INTERVAL

    sensors = state.sensor_data.get(vid, {})

    return {
        "id": vid,
        "type": vehicle.type_id,
        "autopilot_enabled": vehicle.attributes.get("role_name", "") == "autopilot",
        "position": {"x": round(t.location.x, 2), "y": round(t.location.y, 2), "z": round(t.location.z, 2)},
        "rotation": {"pitch": round(t.rotation.pitch, 2), "yaw": round(t.rotation.yaw, 2), "roll": round(t.rotation.roll, 2)},
        "velocity": {
            "x": round(v.x, 2), "y": round(v.y, 2), "z": round(v.z, 2),
            "speed_kmh": round(speed_kmh, 2), "speed_mph": round(speed_kmh * 0.621371, 2),
        },
        "acceleration": {"x": round(a.x, 2), "y": round(a.y, 2), "z": round(a.z, 2)},
        "control": {
            "throttle": round(c.throttle, 2), "steer": round(c.steer, 2), "brake": round(c.brake, 2),
            "hand_brake": c.hand_brake, "reverse": c.reverse, "gear": c.gear,
        },
        "sensors": {
            "imu": sensors.get("imu", {}),
            "gps": sensors.get("gps", {}),
            "last_collision": sensors.get("last_collision"),
            "lane_invasion": sensors.get("lane_invasion"),
        },
        "distance_traveled": round(state.total_distance.get(vid, 0), 2),
    }


def extract_pedestrian(ped) -> Dict:
    t = ped.get_transform()
    v = ped.get_velocity()
    return {
        "id": ped.id,
        "position": {"x": round(t.location.x, 2), "y": round(t.location.y, 2), "z": round(t.location.z, 2)},
        "velocity": {"x": round(v.x, 2), "y": round(v.y, 2), "speed": round((v.x ** 2 + v.y ** 2) ** 0.5, 2)},
        "heading": round(t.rotation.yaw, 2),
    }


def extract_traffic_light(tl) -> Dict:
    t = tl.get_transform()
    state_map = {
        carla.TrafficLightState.Red: "red",
        carla.TrafficLightState.Yellow: "yellow",
        carla.TrafficLightState.Green: "green",
        carla.TrafficLightState.Off: "off",
        carla.TrafficLightState.Unknown: "unknown",
    }
    return {
        "id": tl.id,
        "position": {"x": round(t.location.x, 2), "y": round(t.location.y, 2), "z": round(t.location.z, 2)},
        "state": state_map.get(tl.state, "unknown"),
        "elapsed_time": round(tl.get_elapsed_time(), 2),
    }


def calculate_metrics(vehicles: List[Dict], pedestrians: List[Dict]) -> Dict:
    total_v = len(vehicles)
    total_p = len(pedestrians)
    sensor_count = sum(len(s) for s in state.active_sensors.values())

    if not vehicles:
        return {
            "total_vehicles": 0, "total_pedestrians": total_p,
            "average_speed_kmh": 0, "max_speed_kmh": 0,
            "traffic_density": 0, "total_collisions": state.collision_count,
            "active_sensors": sensor_count,
            "tick_count": state.tick_count,
        }

    speeds = [v["velocity"]["speed_kmh"] for v in vehicles]
    avg_speed = sum(speeds) / len(speeds)
    max_speed = max(speeds)

    # Traffic density: vehicles per 10000m²
    density = 0.0
    if total_v > 1:
        xs = [v["position"]["x"] for v in vehicles]
        ys = [v["position"]["y"] for v in vehicles]
        area = (max(xs) - min(xs)) * (max(ys) - min(ys))
        if area > 0:
            density = total_v / (area / 10000)

    return {
        "total_vehicles": total_v,
        "total_pedestrians": total_p,
        "average_speed_kmh": round(avg_speed, 2),
        "max_speed_kmh": round(max_speed, 2),
        "traffic_density": round(density, 2),
        "total_collisions": state.collision_count,
        "active_sensors": sensor_count,
        "tick_count": state.tick_count,
    }


# ===================== CARLA Connection =====================

async def connect_to_carla() -> bool:
    """Connect to CARLA in read-only mode. No traffic manager, no world loading."""
    try:
        logger.info(f"Connecting to CARLA at {CARLA_HOST}:{CARLA_PORT}")
        state.client = carla.Client(CARLA_HOST, CARLA_PORT)
        state.client.set_timeout(CARLA_TIMEOUT)
        state.world = state.client.get_world()
        state.blueprint_library = state.world.get_blueprint_library()

        settings = state.world.get_settings()
        state.is_synchronous = settings.synchronous_mode
        current_map = state.world.get_map().name.split("/")[-1]

        logger.info(f"Connected to CARLA:")
        logger.info(f"  Map: {current_map}")
        logger.info(f"  Synchronous mode: {state.is_synchronous}")
        return True
    except Exception as e:
        logger.error(f"Failed to connect to CARLA: {e}")
        return False


# ===================== Snapshot Loop =====================

async def update_snapshots():
    """Main loop: read world state, build snapshots, broadcast."""
    while True:
        try:
            if not state.world:
                connected = await connect_to_carla()
                if not connected:
                    await asyncio.sleep(2)
                    continue

            # Check sync mode and tick if needed
            settings = state.world.get_settings()
            state.is_synchronous = settings.synchronous_mode

            if state.is_synchronous:
                state.world.tick()
                state.tick_count += 1

            state.last_tick_time = time.time()

            # Discover actors
            actors = state.world.get_actors()
            vehicles = actors.filter("vehicle.*")
            pedestrians = actors.filter("walker.pedestrian.*")
            traffic_lights = actors.filter("traffic.traffic_light")

            # Attach sensors to new vehicles
            for vehicle in vehicles:
                if vehicle.id not in state.tracked_actors:
                    attach_sensors(vehicle)

            # Clean up destroyed actors
            state.cleanup_destroyed_actors()

            # Extract data
            vehicle_data = [extract_vehicle(v) for v in vehicles]
            pedestrian_data = [extract_pedestrian(p) for p in pedestrians]
            light_data = [extract_traffic_light(tl) for tl in traffic_lights]
            metrics = calculate_metrics(vehicle_data, pedestrian_data)

            # Build snapshot
            snapshot = {
                "timestamp": time.time(),
                "datetime": datetime.utcnow().isoformat(),
                "vehicles": vehicle_data,
                "pedestrians": pedestrian_data,
                "traffic_lights": light_data,
                "metrics": metrics,
                "synchronous_mode": state.is_synchronous,
            }

            state.current_snapshot = snapshot
            state.snapshot_history.append(snapshot)

            # Broadcast to WebSocket clients
            await broadcast(snapshot)

            await asyncio.sleep(SNAPSHOT_INTERVAL)

        except Exception as e:
            logger.error(f"Snapshot loop error: {e}")
            state.world = None  # Force reconnect on next iteration
            await asyncio.sleep(2)


async def broadcast(snapshot: Dict):
    """Send snapshot to all WebSocket clients."""
    if not state.connections:
        return

    message = json.dumps(snapshot)
    disconnected = []

    for ws in state.connections:
        try:
            await ws.send_text(message)
        except Exception:
            disconnected.append(ws)

    for ws in disconnected:
        state.connections.remove(ws)


# ===================== FastAPI Application =====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Snapshot service starting, CARLA target: {CARLA_HOST}:{CARLA_PORT}")
    await connect_to_carla()
    asyncio.create_task(update_snapshots())
    yield
    logger.info("Snapshot service shutting down")
    # Destroy sensors
    for sensors in state.active_sensors.values():
        for sensor in sensors:
            try:
                sensor.destroy()
            except RuntimeError:
                pass


app = FastAPI(
    title="CARLA Snapshot Service",
    description="Read-only streaming service for CARLA simulation data",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {
        "service": "CARLA Snapshot Service",
        "version": "2.0.0",
        "carla_connected": state.world is not None,
        "synchronous_mode": state.is_synchronous,
        "tick_count": state.tick_count,
    }


@app.get("/health")
async def health():
    if not state.world:
        raise HTTPException(status_code=503, detail="Not connected to CARLA")
    return {
        "status": "healthy",
        "tracked_vehicles": len(state.tracked_actors),
        "active_sensors": sum(len(s) for s in state.active_sensors.values()),
        "total_collisions": state.collision_count,
        "websocket_clients": len(state.connections),
        "tick_count": state.tick_count,
    }


@app.get("/snapshot")
async def get_snapshot():
    """Most recent snapshot."""
    return state.current_snapshot


@app.get("/snapshot/history")
async def get_history(limit: int = 50):
    """Historical snapshots."""
    history = list(state.snapshot_history)
    return {"count": len(history), "snapshots": history[-limit:]}


@app.get("/snapshot/vehicle/{vehicle_id}")
async def get_vehicle(vehicle_id: int):
    """Single vehicle data including cameras."""
    for v in state.current_snapshot.get("vehicles", []):
        if v["id"] == vehicle_id:
            result = v.copy()
            if vehicle_id in state.sensor_data:
                result["cameras"] = state.sensor_data[vehicle_id].get("cameras", {})
            return result
    raise HTTPException(status_code=404, detail="Vehicle not found")


@app.get("/snapshot/camera/{vehicle_id}/{camera_id}")
async def get_camera(vehicle_id: int, camera_id: str):
    """Camera feed for a specific vehicle."""
    if vehicle_id not in state.sensor_data:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    cameras = state.sensor_data[vehicle_id].get("cameras", {})
    if camera_id not in cameras:
        raise HTTPException(status_code=404, detail="Camera not found")
    return cameras[camera_id]


@app.get("/metrics")
async def get_metrics():
    """Current simulation metrics."""
    return state.current_snapshot.get("metrics", {})


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """Real-time snapshot stream."""
    await ws.accept()
    state.connections.append(ws)
    logger.info(f"WebSocket client connected ({len(state.connections)} total)")

    try:
        # Send current state immediately
        if state.current_snapshot:
            await ws.send_text(json.dumps(state.current_snapshot))

        while True:
            try:
                await asyncio.wait_for(ws.receive_text(), timeout=30.0)
            except asyncio.TimeoutError:
                await ws.send_text(json.dumps({"type": "ping"}))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        if ws in state.connections:
            state.connections.remove(ws)
            logger.info(f"WebSocket client disconnected ({len(state.connections)} total)")


# ===================== Run Server =====================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("snapshot_service:app", host="0.0.0.0", port=8000, reload=False, log_level="info")
