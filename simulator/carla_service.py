"""
CARLA Simulator Service

Bridges the agent's HTTP config requests to the CARLA Python API.
Manages a persistent CARLA client connection, handles map switching,
actor lifecycle, and autopilot for spawned vehicles.
"""

import os
import random
import asyncio
import logging
from typing import Optional, List
from contextlib import asynccontextmanager
from pathlib import Path

import carla
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from logging.handlers import RotatingFileHandler


# ===================== Configuration =====================

for _candidate in [Path(__file__).parent / '.env', Path(__file__).parent.parent / '.env']:
    if _candidate.exists():
        load_dotenv(dotenv_path=_candidate)
        break

CARLA_HOST = os.getenv("CARLA_HOST", os.getenv("NODE_IP", "localhost"))
CARLA_PORT = int(os.getenv("CARLA_PORT", "2000"))
CARLA_TIMEOUT = float(os.getenv("CARLA_TIMEOUT", "20.0"))

LOG_DIR = Path(os.getenv("LOG_DIR", "/app/logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)

LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)

_file_handler = RotatingFileHandler(
    LOG_DIR / "simulator.log", maxBytes=10 * 1024 * 1024, backupCount=5
)
_file_handler.setFormatter(logging.Formatter(LOG_FORMAT))
_file_handler.setLevel(logging.INFO)
logging.getLogger().addHandler(_file_handler)

logger = logging.getLogger("simulator_service")


# ===================== Request/Response Models =====================

class ConfigRequest(BaseModel):
    weather: str = Field(default="ClearNoon", description="CARLA weather preset")
    map: Optional[str] = Field(default=None, description="CARLA map/town name")
    number_of_vehicles: int = Field(default=20, ge=0)
    number_of_pedestrians: int = Field(default=10, ge=0)
    enable_autopilot: bool = Field(default=True)


class CleanupResponse(BaseModel):
    status: str
    vehicles_destroyed: int = 0
    pedestrians_destroyed: int = 0
    controllers_destroyed: int = 0
    sensors_destroyed: int = 0


class ApplyResponse(BaseModel):
    status: str
    map: Optional[str] = None
    weather: str = ""
    vehicles_spawned: List[int] = []
    pedestrians_spawned: List[int] = []
    error: Optional[str] = None


# ===================== CARLA Client Manager =====================

class CarlaClientManager:
    def __init__(self, host: str, port: int, timeout: float):
        self._host = host
        self._port = port
        self._timeout = timeout
        self._client: Optional[carla.Client] = None
        self._traffic_manager: Optional[carla.TrafficManager] = None

    def connect(self) -> carla.Client:
        if self._client is not None:
            try:
                self._client.get_server_version()
                return self._client
            except Exception:
                logger.warning("Lost connection to CARLA, reconnecting...")
                self._client = None
                self._traffic_manager = None

        logger.info(f"Connecting to CARLA at {self._host}:{self._port}")
        client = carla.Client(self._host, self._port)
        client.set_timeout(self._timeout)
        version = client.get_server_version()
        logger.info(f"Connected to CARLA server v{version}")
        self._client = client
        return client

    @property
    def client(self) -> carla.Client:
        return self.connect()

    @property
    def world(self) -> carla.World:
        return self.client.get_world()

    @property
    def traffic_manager(self) -> carla.TrafficManager:
        if self._traffic_manager is None:
            self._traffic_manager = self.client.get_trafficmanager(8000)
            self._traffic_manager.set_global_distance_to_leading_vehicle(2.5)
            self._traffic_manager.set_synchronous_mode(False)
        return self._traffic_manager

    def load_map(self, map_name: str) -> carla.World:
        current_map = self.world.get_map().name
        current_short = current_map.split("/")[-1]
        if current_short == map_name:
            logger.info(f"Map {map_name} already loaded, skipping reload")
            return self.world
        logger.info(f"Loading map {map_name} (current: {current_short})")
        self._client.load_world(map_name)
        world = self._client.get_world()
        logger.info(f"Map {map_name} loaded successfully")
        return world

    def disconnect(self):
        self._client = None
        self._traffic_manager = None
        logger.info("Disconnected from CARLA")


carla_manager = CarlaClientManager(CARLA_HOST, CARLA_PORT, CARLA_TIMEOUT)


# ===================== Actor Management =====================

def destroy_all_actors(world: carla.World) -> CleanupResponse:
    actors = world.get_actors()
    result = CleanupResponse(status="success")

    for actor in actors.filter("sensor.*"):
        try:
            actor.destroy()
            result.sensors_destroyed += 1
        except RuntimeError as e:
            logger.warning(f"Failed to destroy sensor {actor.id}: {e}")

    for actor in actors.filter("controller.ai.walker"):
        try:
            actor.stop()
            actor.destroy()
            result.controllers_destroyed += 1
        except RuntimeError as e:
            logger.warning(f"Failed to destroy controller {actor.id}: {e}")

    for actor in actors.filter("vehicle.*"):
        try:
            actor.set_autopilot(False)
            actor.destroy()
            result.vehicles_destroyed += 1
        except RuntimeError as e:
            logger.warning(f"Failed to destroy vehicle {actor.id}: {e}")

    for actor in actors.filter("walker.pedestrian.*"):
        try:
            actor.destroy()
            result.pedestrians_destroyed += 1
        except RuntimeError as e:
            logger.warning(f"Failed to destroy walker {actor.id}: {e}")

    logger.info(
        f"Cleanup: {result.vehicles_destroyed} vehicles, "
        f"{result.pedestrians_destroyed} pedestrians, "
        f"{result.sensors_destroyed} sensors, "
        f"{result.controllers_destroyed} controllers"
    )
    return result


def spawn_vehicles(
    world: carla.World,
    count: int,
    enable_autopilot: bool,
    traffic_manager: carla.TrafficManager,
) -> List[int]:
    if count == 0:
        return []

    blueprints = world.get_blueprint_library().filter("vehicle.*")
    spawn_points = world.get_map().get_spawn_points()
    random.shuffle(spawn_points)

    if count > len(spawn_points):
        logger.warning(f"Requested {count} vehicles but only {len(spawn_points)} spawn points, capping")
        count = len(spawn_points)

    batch = []
    for i in range(count):
        bp = random.choice(blueprints)
        if bp.has_attribute("color"):
            color = random.choice(bp.get_attribute("color").recommended_values)
            bp.set_attribute("color", color)
        batch.append(
            carla.command.SpawnActor(bp, spawn_points[i]).then(
                carla.command.SetAutopilot(
                    carla.command.FutureActor, enable_autopilot, traffic_manager.get_port()
                )
            )
        )

    results = carla_manager.client.apply_batch_sync(batch, True)
    spawned = []
    for r in results:
        if r.error:
            logger.warning(f"Vehicle spawn failed: {r.error}")
        else:
            spawned.append(r.actor_id)

    logger.info(f"Spawned {len(spawned)}/{count} vehicles (autopilot={enable_autopilot})")
    return spawned


def spawn_pedestrians(world: carla.World, count: int) -> List[int]:
    if count == 0:
        return []

    blueprints = world.get_blueprint_library().filter("walker.pedestrian.*")
    controller_bp = world.get_blueprint_library().find("controller.ai.walker")

    walker_batch = []
    for _ in range(count):
        bp = random.choice(blueprints)
        if bp.has_attribute("is_invincible"):
            bp.set_attribute("is_invincible", "false")
        location = world.get_random_location_from_navigation()
        if location is None:
            continue
        walker_batch.append(carla.command.SpawnActor(bp, carla.Transform(location)))

    walker_results = carla_manager.client.apply_batch_sync(walker_batch, True)
    walker_ids = []
    for r in walker_results:
        if r.error:
            logger.warning(f"Pedestrian spawn failed: {r.error}")
        else:
            walker_ids.append(r.actor_id)

    controller_batch = []
    for wid in walker_ids:
        controller_batch.append(
            carla.command.SpawnActor(controller_bp, carla.Transform(), world.get_actor(wid))
        )

    controller_results = carla_manager.client.apply_batch_sync(controller_batch, True)

    for r in controller_results:
        if not r.error:
            controller = world.get_actor(r.actor_id)
            if controller is not None:
                controller.start()
                dest = world.get_random_location_from_navigation()
                if dest:
                    controller.go_to_location(dest)
                controller.set_max_speed(1.0 + random.random() * 1.5)

    logger.info(f"Spawned {len(walker_ids)}/{count} pedestrians with AI controllers")
    return walker_ids


# ===================== FastAPI Application =====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Simulator service starting, CARLA target: {CARLA_HOST}:{CARLA_PORT}")
    try:
        carla_manager.connect()
    except Exception as e:
        logger.warning(f"Initial CARLA connection failed (will retry on first request): {e}")
    yield
    logger.info("Simulator service shutting down")
    carla_manager.disconnect()


app = FastAPI(
    title="CARLA Simulator Service",
    description="HTTP bridge to CARLA Python API",
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
    connected = False
    server_version = None
    try:
        server_version = carla_manager.client.get_server_version()
        connected = True
    except Exception:
        pass
    return {
        "service": "CARLA Simulator Service",
        "version": "2.0.0",
        "carla_connected": connected,
        "carla_server_version": server_version,
        "carla_host": CARLA_HOST,
        "carla_port": CARLA_PORT,
    }


@app.get("/health")
async def health():
    try:
        version = carla_manager.client.get_server_version()
        current_map = carla_manager.world.get_map().name.split("/")[-1]
        return {"status": "healthy", "carla_version": version, "current_map": current_map}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"CARLA unavailable: {e}")


@app.post("/apply_config", response_model=ApplyResponse)
async def apply_config(config: ConfigRequest):
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, _apply_config_sync, config
        )
        return result
    except Exception as e:
        logger.error(f"Failed to apply config: {e}")
        return ApplyResponse(status="error", error=str(e))


def _apply_config_sync(config: ConfigRequest) -> ApplyResponse:
    if config.map:
        world = carla_manager.load_map(config.map)
    else:
        world = carla_manager.world

    destroy_all_actors(world)

    weather_applied = "ClearNoon"
    try:
        weather_param = getattr(carla.WeatherParameters, config.weather)
        world.set_weather(weather_param)
        weather_applied = config.weather
        logger.info(f"Weather set to {config.weather}")
    except AttributeError:
        logger.warning(f"Unknown weather preset '{config.weather}', keeping current")
        weather_applied = config.weather + " (unknown, not applied)"

    world.tick()

    vehicle_ids = spawn_vehicles(
        world, config.number_of_vehicles, config.enable_autopilot, carla_manager.traffic_manager
    )
    pedestrian_ids = spawn_pedestrians(world, config.number_of_pedestrians)

    current_map = world.get_map().name.split("/")[-1]

    return ApplyResponse(
        status="success",
        map=current_map,
        weather=weather_applied,
        vehicles_spawned=vehicle_ids,
        pedestrians_spawned=pedestrian_ids,
    )


@app.post("/cleanup", response_model=CleanupResponse)
async def cleanup():
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: destroy_all_actors(carla_manager.world)
        )
        return result
    except Exception as e:
        logger.error(f"Cleanup failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/world_info")
async def world_info():
    try:
        world = carla_manager.world
        actors = world.get_actors()
        current_map = world.get_map().name.split("/")[-1]
        weather = world.get_weather()
        return {
            "map": current_map,
            "vehicles": len(actors.filter("vehicle.*")),
            "pedestrians": len(actors.filter("walker.pedestrian.*")),
            "sensors": len(actors.filter("sensor.*")),
            "weather": {
                "cloudiness": weather.cloudiness,
                "precipitation": weather.precipitation,
                "wind_intensity": weather.wind_intensity,
                "sun_altitude_angle": weather.sun_altitude_angle,
                "fog_density": weather.fog_density,
            },
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("simulator_service:app", host="0.0.0.0", port=8502, reload=True, log_level="info")
