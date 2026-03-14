'use client';

import { useEffect, useRef, useState } from 'react';
import { Car, Users, Gauge, Circle, Radio, AlertCircle } from 'lucide-react';

// ===================== Types (aligned with snapshot_service.py) =====================

interface MapBounds {
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
}

interface Vehicle {
  id: number;
  type: string;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number; roll: number };
  velocity: { x: number; y: number; z: number; speed_kmh: number };
  autopilot_enabled?: boolean;
  distance_traveled?: number;
  control?: { throttle: number; brake: number; gear: number };
  sensors?: {
    last_collision?: { timestamp: number; other_actor: string } | null;
  };
}

interface Pedestrian {
  id: number;
  position: { x: number; y: number; z: number };
  velocity: { speed: number };
  heading: number;
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

interface MapVisualizationProps {
  simulationId: string;
}

// ===================== Theme =====================

const THEME = {
  canvasBg: '#0d1117',
  grid: 'rgba(255,255,255,0.04)',
  gridAxis: 'rgba(255,255,255,0.12)',
  overlayBg: 'rgba(17,17,22,0.9)',
  overlayBorder: '1px solid rgba(255,255,255,0.06)',
  textPrimary: '#d1d5db',
  textSecondary: '#9ca3af',
  textMuted: '#6b7280',
  textDim: '#4b5563',
  divider: 'rgba(255,255,255,0.06)',
  green: '#4ade80',
  greenBg: 'rgba(34,197,94,0.1)',
  red: '#f87171',
  redBg: 'rgba(239,68,68,0.1)',
};

const LIGHT_COLORS: Record<string, string> = {
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
  off: '#374151',
  unknown: '#6b7280',
};

// ===================== Coordinate Helpers =====================

function calculateBounds(vehicles: Vehicle[], pedestrians: Pedestrian[]): MapBounds {
  const allPositions = [
    ...vehicles.map((v) => v.position),
    ...pedestrians.map((p) => p.position),
  ];

  if (allPositions.length === 0) {
    return { min_x: -100, max_x: 100, min_y: -100, max_y: 100 };
  }

  let min_x = Infinity, max_x = -Infinity, min_y = Infinity, max_y = -Infinity;
  for (const p of allPositions) {
    min_x = Math.min(min_x, p.x); max_x = Math.max(max_x, p.x);
    min_y = Math.min(min_y, p.y); max_y = Math.max(max_y, p.y);
  }

  const px = Math.max((max_x - min_x) * 0.25, 30);
  const py = Math.max((max_y - min_y) * 0.25, 30);
  return { min_x: min_x - px, max_x: max_x + px, min_y: min_y - py, max_y: max_y + py };
}

function worldToScreen(wx: number, wy: number, b: MapBounds, w: number, h: number) {
  const padding = 40;
  const availW = w - padding * 2;
  const availH = h - padding * 2;
  const worldW = b.max_x - b.min_x;
  const worldH = b.max_y - b.min_y;

  const scale = Math.min(availW / worldW, availH / worldH);
  const ox = (w - worldW * scale) / 2;
  const oy = (h - worldH * scale) / 2;

  return {
    x: (wx - b.min_x) * scale + ox,
    y: h - ((wy - b.min_y) * scale + oy), // Invert Y for CARLA -> Canvas
  };
}

// ===================== Drawing logic =====================

function drawGrid(ctx: CanvasRenderingContext2D, b: MapBounds, w: number, h: number) {
  const spacing = 20; 
  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.floor(b.min_x / spacing) * spacing; x <= b.max_x; x += spacing) {
    const p1 = worldToScreen(x, b.min_y, b, w, h);
    const p2 = worldToScreen(x, b.max_y, b, w, h);
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  }
  for (let y = Math.floor(b.min_y / spacing) * spacing; y <= b.max_y; y += spacing) {
    const p1 = worldToScreen(b.min_x, y, b, w, h);
    const p2 = worldToScreen(b.max_x, y, b, w, h);
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();
}

// ===================== Main Component =====================

export default function MapVisualization({ simulationId }: MapVisualizationProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const boundsRef = useRef<MapBounds | null>(null);
  const currentDataRef = useRef<SnapshotData | null>(null);
  const fpsRef = useRef({ frames: 0, lastTime: performance.now() });

  const [isConnected, setIsConnected] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [fps, setFps] = useState(0);
  const [hoveredVehicle, setHoveredVehicle] = useState<Vehicle | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const render = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const data = currentDataRef.current;
    const bounds = boundsRef.current;

    ctx.fillStyle = THEME.canvasBg;
    ctx.fillRect(0, 0, w, h);

    if (data && bounds) {
      // Calculate FPS
      fpsRef.current.frames++;
      const now = performance.now();
      if (now - fpsRef.current.lastTime >= 1000) {
        setFps(Math.round((fpsRef.current.frames * 1000) / (now - fpsRef.current.lastTime)));
        fpsRef.current.frames = 0;
        fpsRef.current.lastTime = now;
      }

      drawGrid(ctx, bounds, w, h);
      
      // Draw Pedestrians
      data.pedestrians.forEach(ped => {
        const p = worldToScreen(ped.position.x, ped.position.y, bounds, w, h);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#2dd4bf';
        ctx.fill();
      });

      // Draw Vehicles
      data.vehicles.forEach(v => {
        const p = worldToScreen(v.position.x, v.position.y, bounds, w, h);
        const rotation = ((90 - v.rotation.yaw) * Math.PI) / 180;
        
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(rotation);

        // Body
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.fillStyle = v.velocity.speed_kmh > 40 ? '#f59e0b' : '#38bdf8';
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Arrow
        ctx.beginPath();
        ctx.moveTo(10, 0); ctx.lineTo(6, -3); ctx.lineTo(6, 3); ctx.closePath();
        ctx.fillStyle = 'white';
        ctx.fill();
        ctx.restore();
      });
    }

    animationFrameRef.current = requestAnimationFrame(render);
  };

  useEffect(() => {
    const NODE_IP = process.env.NEXT_PUBLIC_NODE_IP || 'localhost';
    const SNAP_PORT = process.env.NEXT_PUBLIC_SNAPSHOT_PORT || '8000';
    const ws = new WebSocket(`ws://${NODE_IP}:${SNAP_PORT}/ws`);

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (e) => {
      try {
        const data: SnapshotData = JSON.parse(e.data);
        currentDataRef.current = data;
        boundsRef.current = calculateBounds(data.vehicles, data.pedestrians);
        setMetrics(data.metrics);
      } catch (err) { /* ignore pings */ }
    };

    wsRef.current = ws;
    animationFrameRef.current = requestAnimationFrame(render);

    const handleResize = () => {
      if (canvasRef.current && canvasRef.current.parentElement) {
        canvasRef.current.width = canvasRef.current.parentElement.clientWidth;
        canvasRef.current.height = canvasRef.current.parentElement.clientHeight;
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      ws.close();
      window.removeEventListener('resize', handleResize);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-2xl border border-white/5 bg-[#0d1117]">
      <canvas ref={canvasRef} className="h-full w-full" />

      {/* Stats Overlay */}
      <div className="absolute top-4 left-4 flex gap-4 rounded-xl bg-black/60 p-3 backdrop-blur-md border border-white/10">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs text-gray-300 font-mono">{fps} FPS</span>
        </div>
        <div className="h-4 w-px bg-white/10" />
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <div className="flex items-center gap-1"><Car size={12}/> {metrics?.total_vehicles ?? 0}</div>
          <div className="flex items-center gap-1"><Users size={12}/> {metrics?.total_pedestrians ?? 0}</div>
        </div>
      </div>

      {/* Metrics Overlay */}
      {metrics && (
        <div className="absolute top-4 right-4 flex gap-6 rounded-xl bg-black/60 p-3 backdrop-blur-md border border-white/10">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-gray-500">Avg Speed</p>
            <p className="text-sm font-medium text-white">{(metrics.average_speed_kmh || 0).toFixed(1)} <span className="text-[10px] text-gray-500">km/h</span></p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-gray-500">Collisions</p>
            <p className={`text-sm font-medium ${metrics.total_collisions > 0 ? 'text-red-400' : 'text-green-400'}`}>{metrics.total_collisions}</p>
          </div>
        </div>
      )}

      {!isConnected && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-red-400 text-sm font-medium bg-red-950/30 px-4 py-2 rounded-full border border-red-500/20">
            <AlertCircle size={16} /> Disconnected from Snapshot Service
          </div>
        </div>
      )}
    </div>
  );
}
