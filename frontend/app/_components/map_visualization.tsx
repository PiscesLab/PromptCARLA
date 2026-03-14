'use client';

import { useEffect, useRef, useState } from 'react';
import { Car, Users, Gauge, Circle, AlertCircle } from 'lucide-react';

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

const THEME = {
  canvasBg: '#0d1117',
  grid: 'rgba(255,255,255,0.04)',
  green: '#4ade80',
  red: '#f87171',
  yellow: '#fbbf24',
};

const LIGHT_COLORS: Record<string, string> = {
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
  off: '#374151',
  unknown: '#6b7280',
};

// ===================== Helpers =====================

function calculateBounds(vehicles: Vehicle[], peds: Pedestrian[], lights: TrafficLight[] = []): MapBounds {
  const allPos = [
    ...vehicles.map(v => v.position),
    ...peds.map(p => p.position),
    ...lights.map(l => l.position)
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

function drawTrafficLights(ctx: CanvasRenderingContext2D, lights: TrafficLight[], b: MapBounds, w: number, h: number) {
  lights.forEach(l => {
    const p = worldToScreen(l.position.x, l.position.y, b, w, h);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = LIGHT_COLORS[l.state] || LIGHT_COLORS.unknown;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}

// ===================== Main Component =====================

export default function MapVisualization({ simulationId }: { simulationId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentDataRef = useRef<SnapshotData | null>(null);
  const boundsRef = useRef<MapBounds | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  const render = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = THEME.canvasBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const data = currentDataRef.current;
    const b = boundsRef.current;
    if (data && b) {
      // 1. Draw Traffic Lights
      drawTrafficLights(ctx, data.traffic_lights || [], b, canvas.width, canvas.height);

      // 2. Draw Peds
      data.pedestrians.forEach(ped => {
        const p = worldToScreen(ped.position.x, ped.position.y, b, canvas.width, canvas.height);
        ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#2dd4bf'; ctx.fill();
      });

      // 3. Draw Vehicles
      data.vehicles.forEach(v => {
        const p = worldToScreen(v.position.x, v.position.y, b, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(((90 - v.rotation.yaw) * Math.PI) / 180);
        ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.fillStyle = v.velocity.speed_kmh > 40 ? THEME.yellow : '#38bdf8';
        ctx.fill();
        ctx.restore();
      });
    }
    requestAnimationFrame(render);
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
    requestAnimationFrame(render);

    return () => {
      ws.close();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <div className="relative h-full w-full rounded-2xl border border-white/5 bg-[#0d1117]">
      <canvas ref={canvasRef} className="h-full w-full" />
      {/* Overlay UI truncated for brevity, same as previous version */}
    </div>
  );
}
