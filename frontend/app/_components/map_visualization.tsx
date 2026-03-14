'use client';
import { useEffect, useRef, useState } from 'react';
import { Car, Users, Gauge, AlertCircle } from 'lucide-react';

// ===================== Types =====================
interface MapBounds {
  min_x: number; max_x: number; min_y: number; max_y: number;
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
function getTheme() {
  return {
    canvasBg:    '#ffffff',
    border:      'rgba(0,0,0,0.08)',
    muted:       '#6b7280',
    vehicle:     '#2563eb',
    vehicleFast: '#d97706',
    pedestrian:  '#059669',
  };
}

const LIGHT_COLORS: Record<string, string> = {
  red:     '#ef4444',
  yellow:  '#eab308',
  green:   '#22c55e',
  off:     '#374151',
  unknown: '#6b7280',
};

// ===================== Helpers =====================
function calculateBounds(vehicles: Vehicle[], peds: Pedestrian[], lights: TrafficLight[] = []): MapBounds {
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
  const currentDataRef = useRef<SnapshotData | null>(null);
  const boundsRef = useRef<MapBounds | null>(null);
  const rafRef = useRef<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  const render = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const theme = getTheme();
    const { width: w, height: h } = canvas;

    // Background
    ctx.fillStyle = theme.canvasBg;
    ctx.fillRect(0, 0, w, h);

    const data = currentDataRef.current;
    const b = boundsRef.current;

    if (data && b) {
      // Traffic lights
      (data.traffic_lights || []).forEach(l => {
        const p = worldToScreen(l.position.x, l.position.y, b, w, h);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = LIGHT_COLORS[l.state] || LIGHT_COLORS.unknown;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });

      // Pedestrians
      data.pedestrians.forEach(ped => {
        const p = worldToScreen(ped.position.x, ped.position.y, b, w, h);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = theme.pedestrian;
        ctx.fill();
      });

      // Vehicles
      data.vehicles.forEach(v => {
        const p = worldToScreen(v.position.x, v.position.y, b, w, h);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(((90 - v.rotation.yaw) * Math.PI) / 180);
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.fillStyle = v.velocity.speed_kmh > 40 ? theme.vehicleFast : theme.vehicle;
        ctx.fill();
        ctx.restore();
      });
    }

    rafRef.current = requestAnimationFrame(render);
  };

  useEffect(() => {
    const IP = process.env.NEXT_PUBLIC_NODE_IP || 'localhost';
    const PORT = process.env.NEXT_PUBLIC_SNAPSHOT_PORT || '8000';
    const ws = new WebSocket(`ws://${IP}:${PORT}/ws`);

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (e) => {
      try {
        const data: SnapshotData = JSON.parse(e.data);
        currentDataRef.current = data;
        boundsRef.current = calculateBounds(data.vehicles, data.pedestrians, data.traffic_lights);
        setMetrics(data.metrics);
      } catch {}
    };

    const handleResize = () => {
      if (canvasRef.current?.parentElement) {
        canvasRef.current.width = canvasRef.current.parentElement.clientWidth;
        canvasRef.current.height = canvasRef.current.parentElement.clientHeight;
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();
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

      {/* Connection status */}
      <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md border bg-card/80 px-2 py-1 backdrop-blur-sm">
        <div className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-green-400' : 'bg-destructive'}`} />
        <span className="text-xs text-muted-foreground">{isConnected ? 'Live' : 'Disconnected'}</span>
      </div>

      {/* Metrics overlay */}
      {metrics && (
        <div className="absolute bottom-3 left-3 flex gap-2">
          <div className="flex items-center gap-1.5 rounded-md border bg-card/80 px-2 py-1 backdrop-blur-sm">
            <Car size={12} className="text-muted-foreground" />
            <span className="text-xs text-foreground">{metrics.total_vehicles}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border bg-card/80 px-2 py-1 backdrop-blur-sm">
            <Users size={12} className="text-muted-foreground" />
            <span className="text-xs text-foreground">{metrics.total_pedestrians}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border bg-card/80 px-2 py-1 backdrop-blur-sm">
            <Gauge size={12} className="text-muted-foreground" />
            <span className="text-xs text-foreground">{metrics.average_speed_kmh?.toFixed(0)} km/h</span>
          </div>
          {metrics.total_collisions > 0 && (
            <div className="flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 backdrop-blur-sm">
              <AlertCircle size={12} className="text-destructive" />
              <span className="text-xs text-destructive">{metrics.total_collisions}</span>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1 rounded-md border bg-card/80 px-3 py-2 backdrop-blur-sm">
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-primary" />
          <span className="text-xs text-muted-foreground">Vehicle</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-chart-3" />
          <span className="text-xs text-muted-foreground">Pedestrian</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-chart-4" />
          <span className="text-xs text-muted-foreground">Fast (&gt;40 km/h)</span>
        </div>
      </div>
    </div>
  );
}
