'use client';
import { useEffect, useRef, useState } from 'react';
import { Car, Users, Gauge, AlertCircle } from 'lucide-react';

// ===================== Types =====================
interface MapBounds {
  min_x: number; max_x: number; min_y: number; max_y: number;
}
interface RoadSegment {
  start: { x: number; y: number };
  end:   { x: number; y: number };
}
interface MapData {
  map_name: string;
  roads: RoadSegment[];
  spawn_points: { x: number; y: number }[];
}
interface Vehicle {
  id: number;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number; roll: number };
  velocity: { speed_kmh: number };
  autopilot_enabled?: boolean;
}
interface Pedestrian {
  id: number;
  position: { x: number; y: number; z: number };
}
interface TrafficLight {
  id: number;
  position: { x: number; y: number; z: number };
  state: 'red' | 'yellow' | 'green' | 'off' | 'unknown';
}
interface Metrics {
  total_vehicles: number;
  total_pedestrians: number;
  average_speed_kmh: number;
  max_speed_kmh: number;
  traffic_density?: number;
  total_collisions: number;
}
interface SnapshotData {
  timestamp: number;
  vehicles: Vehicle[];
  pedestrians: Pedestrian[];
  traffic_lights?: TrafficLight[];
  metrics: Metrics;
}

// ===================== Theme =====================
const THEME = {
  canvasBg:    '#ffffff',
  road:        '#d1d5db',
  vehicle:     '#2563eb',
  vehicleFast: '#d97706',
  pedestrian:  '#059669',
};

const LIGHT_COLORS: Record<string, string> = {
  red:     '#ef4444',
  yellow:  '#eab308',
  green:   '#22c55e',
  off:     '#d1d5db',
  unknown: '#9ca3af',
};

// ===================== Helpers =====================
function boundsFromRoads(roads: RoadSegment[]): MapBounds {
  if (roads.length === 0) return { min_x: -100, max_x: 100, min_y: -100, max_y: 100 };
  let min_x = Infinity, max_x = -Infinity, min_y = Infinity, max_y = -Infinity;
  roads.forEach(r => {
    min_x = Math.min(min_x, r.start.x, r.end.x);
    max_x = Math.max(max_x, r.start.x, r.end.x);
    min_y = Math.min(min_y, r.start.y, r.end.y);
    max_y = Math.max(max_y, r.start.y, r.end.y);
  });
  const padX = (max_x - min_x) * 0.05;
  const padY = (max_y - min_y) * 0.05;
  return { min_x: min_x - padX, max_x: max_x + padX, min_y: min_y - padY, max_y: max_y + padY };
}

function boundsFromActors(vehicles: Vehicle[], peds: Pedestrian[], lights: TrafficLight[] = []): MapBounds {
  const allPos = [
    ...vehicles.map(v => v.position),
    ...peds.map(p => p.position),
    ...lights.map(l => l.position),
  ];
  if (allPos.length === 0) return { min_x: -100, max_x: 100, min_y: -100, max_y: 100 };
  let min_x = Infinity, max_x = -Infinity, min_y = Infinity, max_y = -Infinity;
  allPos.forEach(p => {
    min_x = Math.min(min_x, p.x); max_x = Math.max(max_x, p.x);
    min_y = Math.min(min_y, p.y); max_y = Math.max(max_y, p.y);
  });
  const padX = Math.max((max_x - min_x) * 0.2, 40);
  const padY = Math.max((max_y - min_y) * 0.2, 40);
  return { min_x: min_x - padX, max_x: max_x + padX, min_y: min_y - padY, max_y: max_y + padY };
}

function worldToScreen(wx: number, wy: number, b: MapBounds, w: number, h: number) {
  const scale = Math.min((w - 80) / (b.max_x - b.min_x), (h - 80) / (b.max_y - b.min_y));
  const ox = (w - (b.max_x - b.min_x) * scale) / 2;
  const oy = (h - (b.max_y - b.min_y) * scale) / 2;
  return {
    x: (wx - b.min_x) * scale + ox,
    y: h - ((wy - b.min_y) * scale + oy),
  };
}

// ===================== Main Component =====================
export default function MapVisualization({ simulationId }: { simulationId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapshotRef = useRef<SnapshotData | null>(null);
  const boundsRef = useRef<MapBounds | null>(null);
  const mapDataRef = useRef<MapData | null>(null);
  const rafRef = useRef<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [mapName, setMapName] = useState<string | null>(null);

  useEffect(() => {
    const IP = process.env.NEXT_PUBLIC_NODE_IP || 'localhost';
    const PORT = process.env.NEXT_PUBLIC_SNAPSHOT_PORT || '8000';
    const API = `http://${IP}:${PORT}`;

    // -- Fetch road topology once --
    fetch(`${API}/map_data`)
      .then(r => r.json())
      .then((data: MapData) => {
        mapDataRef.current = data;
        boundsRef.current = boundsFromRoads(data.roads);
        setMapName(data.map_name);
      })
      .catch(() => {
        // map_data unavailable — bounds fall back to actor positions
      });

    // -- WebSocket for live actor data --
    const ws = new WebSocket(`ws://${IP}:${PORT}/ws`);
    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (e) => {
      try {
        const data: SnapshotData = JSON.parse(e.data);
        snapshotRef.current = data;
        // Only use actor-based bounds if road data hasn't loaded yet
        if (!mapDataRef.current) {
          boundsRef.current = boundsFromActors(data.vehicles, data.pedestrians, data.traffic_lights);
        }
        setMetrics(data.metrics);
      } catch {}
    };

    // -- Resize --
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (canvas?.parentElement) {
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();

    // -- Render loop defined inside useEffect so it closes over refs correctly --
    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const { width: w, height: h } = canvas;
      const b = boundsRef.current;
      const data = snapshotRef.current;

      ctx.fillStyle = THEME.canvasBg;
      ctx.fillRect(0, 0, w, h);

      if (!b) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      // 1. Roads
      const roads = mapDataRef.current?.roads ?? [];
      if (roads.length > 0) {
        ctx.strokeStyle = THEME.road;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        roads.forEach(road => {
          const s = worldToScreen(road.start.x, road.start.y, b, w, h);
          const e = worldToScreen(road.end.x,   road.end.y,   b, w, h);
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(e.x, e.y);
        });
        ctx.stroke();
      }

      if (data) {
        // 2. Traffic lights
        (data.traffic_lights || []).forEach(l => {
          const p = worldToScreen(l.position.x, l.position.y, b, w, h);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = LIGHT_COLORS[l.state] || LIGHT_COLORS.unknown;
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.15)';
          ctx.lineWidth = 1;
          ctx.stroke();
        });

        // 3. Pedestrians
        data.pedestrians.forEach(ped => {
          const p = worldToScreen(ped.position.x, ped.position.y, b, w, h);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = THEME.pedestrian;
          ctx.fill();
        });

        // 4. Vehicles — oriented rectangles with a direction dot
        data.vehicles.forEach(v => {
          const p = worldToScreen(v.position.x, v.position.y, b, w, h);
          const fast = v.velocity.speed_kmh > 40;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(((90 - v.rotation.yaw) * Math.PI) / 180);
          ctx.beginPath();
          ctx.roundRect(-5, -9, 10, 18, 2);
          ctx.fillStyle = fast ? THEME.vehicleFast : THEME.vehicle;
          ctx.fill();
          // Front indicator dot
          ctx.beginPath();
          ctx.arc(0, -6, 2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.8)';
          ctx.fill();
          ctx.restore();
        });
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      ws.close();
      window.removeEventListener('resize', handleResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div className="relative h-full w-full rounded-xl bg-white">
      <canvas ref={canvasRef} className="h-full w-full" />

      {/* Connection status + map name */}
      <div className="absolute left-3 top-3 flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md border bg-white/90 px-2 py-1 shadow-sm">
          <div className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-400'}`} />
          <span className="text-xs text-gray-500">{isConnected ? 'Live' : 'Disconnected'}</span>
        </div>
        {mapName && (
          <div className="rounded-md border bg-white/90 px-2 py-1 shadow-sm">
            <span className="text-xs text-gray-500">{mapName}</span>
          </div>
        )}
      </div>

      {/* Metrics */}
      {metrics && (
        <div className="absolute bottom-3 left-3 flex gap-2">
          <div className="flex items-center gap-1.5 rounded-md border bg-white/90 px-2 py-1 shadow-sm">
            <Car size={12} className="text-gray-400" />
            <span className="text-xs text-gray-600">{metrics.total_vehicles}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border bg-white/90 px-2 py-1 shadow-sm">
            <Users size={12} className="text-gray-400" />
            <span className="text-xs text-gray-600">{metrics.total_pedestrians}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border bg-white/90 px-2 py-1 shadow-sm">
            <Gauge size={12} className="text-gray-400" />
            <span className="text-xs text-gray-600">{metrics.average_speed_kmh?.toFixed(0)} km/h</span>
          </div>
          {metrics.total_collisions > 0 && (
            <div className="flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50/90 px-2 py-1 shadow-sm">
              <AlertCircle size={12} className="text-red-400" />
              <span className="text-xs text-red-500">{metrics.total_collisions}</span>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1 rounded-md border bg-white/90 px-3 py-2 shadow-sm">
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-3 rounded-sm" style={{ background: THEME.vehicle }} />
          <span className="text-xs text-gray-500">Vehicle</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-3 rounded-sm" style={{ background: THEME.vehicleFast }} />
          <span className="text-xs text-gray-500">Fast (&gt;40 km/h)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full" style={{ background: THEME.pedestrian }} />
          <span className="text-xs text-gray-500">Pedestrian</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-3 rounded-sm" style={{ background: THEME.road }} />
          <span className="text-xs text-gray-500">Road</span>
        </div>
      </div>
    </div>
  );
}
