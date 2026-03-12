'use client';

import { useEffect, useRef, useState } from 'react';
import { Car, Users, Gauge, Circle, Radio, AlertCircle } from 'lucide-react';

// ===================== Types (matching snapshot_service.py output) =====================

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
  velocity: { x: number; y: number; z: number; speed_kmh: number; speed_mph: number };
  acceleration: { x: number; y: number; z: number };
  autopilot_enabled?: boolean;
  distance_traveled?: number;
  control?: { throttle: number; brake: number; steer: number; hand_brake: boolean; reverse: boolean; gear: number };
  sensors?: {
    imu?: Record<string, unknown>;
    gps?: Record<string, unknown>;
    last_collision?: { timestamp: number; other_actor: string } | null;
    lane_invasion?: { timestamp: number; crossed_lanes: string[] } | null;
  };
}

interface Pedestrian {
  id: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; speed: number };
  heading: number;
}

interface TrafficLight {
  id: number;
  position: { x: number; y: number; z: number };
  state: 'red' | 'yellow' | 'green' | 'off' | 'unknown';
  elapsed_time: number;
}

interface Metrics {
  total_vehicles: number;
  total_pedestrians: number;
  average_speed_kmh: number;
  max_speed_kmh: number;
  traffic_density: number;
  total_collisions: number;
  active_sensors: number;
  tick_count: number;
}

interface SnapshotData {
  timestamp: number;
  datetime: string;
  vehicles: Vehicle[];
  pedestrians: Pedestrian[];
  traffic_lights: TrafficLight[];
  metrics: Metrics;
  synchronous_mode: boolean;
}

interface MapVisualizationProps {
  simulationId: string;
  wsUrl?: string;
}

// ===================== Theme (matches chat page.tsx) =====================

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
  amber: '#fbbf24',
  amberBg: 'rgba(234,179,8,0.1)',
};

const LIGHT_COLORS: Record<string, string> = {
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
  off: '#374151',
  unknown: '#6b7280',
};

// ===================== Canvas Helpers =====================

function calculateBounds(vehicles: Vehicle[], pedestrians: Pedestrian[]): MapBounds {
  const allPositions = [
    ...vehicles.map((v) => v.position),
    ...pedestrians.map((p) => p.position),
  ];

  if (allPositions.length === 0) {
    return { min_x: -100, max_x: 100, min_y: -100, max_y: 100 };
  }

  let min_x = Infinity, max_x = -Infinity;
  let min_y = Infinity, max_y = -Infinity;

  for (const p of allPositions) {
    min_x = Math.min(min_x, p.x);
    max_x = Math.max(max_x, p.x);
    min_y = Math.min(min_y, p.y);
    max_y = Math.max(max_y, p.y);
  }

  const px = Math.max((max_x - min_x) * 0.2, 20);
  const py = Math.max((max_y - min_y) * 0.2, 20);

  return { min_x: min_x - px, max_x: max_x + px, min_y: min_y - py, max_y: max_y + py };
}

function worldToScreen(wx: number, wy: number, b: MapBounds, w: number, h: number) {
  const pad = 50;
  const uw = w - pad * 2;
  const uh = h - pad * 2;
  const mw = b.max_x - b.min_x;
  const mh = b.max_y - b.min_y;
  const s = Math.min(uw / mw, uh / mh);
  const ox = (w - mw * s) / 2;
  const oy = (h - mh * s) / 2;
  return {
    x: (wx - b.min_x) * s + ox,
    y: h - ((wy - b.min_y) * s + oy),
  };
}

function drawGrid(ctx: CanvasRenderingContext2D, b: MapBounds, w: number, h: number) {
  const mw = b.max_x - b.min_x;
  const mh = b.max_y - b.min_y;
  const spacing = Math.pow(10, Math.floor(Math.log10(Math.max(mw, mh) / 10)));

  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = Math.floor(b.min_x / spacing) * spacing; x <= b.max_x; x += spacing) {
    const p1 = worldToScreen(x, b.min_y, b, w, h);
    const p2 = worldToScreen(x, b.max_y, b, w, h);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  for (let y = Math.floor(b.min_y / spacing) * spacing; y <= b.max_y; y += spacing) {
    const p1 = worldToScreen(b.min_x, y, b, w, h);
    const p2 = worldToScreen(b.max_x, y, b, w, h);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // Origin axes
  ctx.strokeStyle = THEME.gridAxis;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (b.min_x <= 0 && b.max_x >= 0) {
    const p1 = worldToScreen(0, b.min_y, b, w, h);
    const p2 = worldToScreen(0, b.max_y, b, w, h);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  if (b.min_y <= 0 && b.max_y >= 0) {
    const p1 = worldToScreen(b.min_x, 0, b, w, h);
    const p2 = worldToScreen(b.max_x, 0, b, w, h);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();
}

function drawTrafficLights(ctx: CanvasRenderingContext2D, lights: TrafficLight[], b: MapBounds, w: number, h: number) {
  for (const light of lights) {
    const p = worldToScreen(light.position.x, light.position.y, b, w, h);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = LIGHT_COLORS[light.state] || LIGHT_COLORS.unknown;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawVehicles(ctx: CanvasRenderingContext2D, vehicles: Vehicle[], b: MapBounds, w: number, h: number) {
  for (const v of vehicles) {
    const p = worldToScreen(v.position.x, v.position.y, b, w, h);
    const maxSpeed = 100;
    const ratio = Math.min(v.velocity.speed_kmh / maxSpeed, 1);

    // Sky blue (slow) -> amber (fast) -- matches JSON syntax highlight colors
    const r = Math.floor(56 + ratio * 189);  // 56 -> 245
    const g = Math.floor(189 - ratio * 31);   // 189 -> 158
    const bl = Math.floor(220 - ratio * 220);  // 220 -> 0

    ctx.save();
    ctx.translate(p.x, p.y);

    const speed = Math.sqrt(v.velocity.x ** 2 + v.velocity.y ** 2);
    const rotation = speed > 0.5
      ? Math.atan2(-v.velocity.y, v.velocity.x)
      : ((90 - v.rotation.yaw) * Math.PI) / 180;

    ctx.rotate(rotation);

    // Collision ring
    if (v.sensors?.last_collision) {
      const age = Date.now() / 1000 - v.sensors.last_collision.timestamp;
      if (age < 5) {
        const alpha = Math.max(0, 1 - age / 5);
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239,68,68,${alpha})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Vehicle body
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${r}, ${g}, ${bl})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Direction arrow
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(6, -3.5);
    ctx.lineTo(6, 3.5);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();

    ctx.restore();
  }
}

function drawPedestrians(ctx: CanvasRenderingContext2D, pedestrians: Pedestrian[], b: MapBounds, w: number, h: number) {
  for (const ped of pedestrians) {
    const p = worldToScreen(ped.position.x, ped.position.y, b, w, h);

    // Small teal dot for pedestrians
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#2dd4bf'; // teal-400
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Heading indicator
    if (ped.velocity.speed > 0.3) {
      const angle = (ped.heading * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(angle) * 7, p.y - Math.sin(angle) * 7);
      ctx.lineTo(p.x + Math.cos(angle) * 4, p.y - Math.sin(angle) * 4);
      ctx.strokeStyle = 'rgba(45,212,191,0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number, connected: boolean, wsUrl: string) {
  ctx.fillStyle = THEME.canvasBg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  ctx.fillStyle = THEME.textMuted;
  ctx.font = '14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    connected ? 'Connected -- waiting for vehicle data...' : 'Connecting to simulation...',
    w / 2, h / 2 - 10
  );
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = THEME.textDim;
  ctx.fillText(wsUrl, w / 2, h / 2 + 12);
}

// ===================== Component =====================

export default function MapVisualization({
  simulationId,
  wsUrl = 'ws://localhost:8000/ws',
}: MapVisualizationProps) {
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
  const [hoveredPedestrian, setHoveredPedestrian] = useState<Pedestrian | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // -- Render loop --
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

    if (!data || !bounds) {
      drawPlaceholder(ctx, w, h, isConnected, wsUrl);
      animationFrameRef.current = requestAnimationFrame(render);
      return;
    }

    // FPS
    fpsRef.current.frames++;
    const now = performance.now();
    if (now - fpsRef.current.lastTime >= 1000) {
      setFps(Math.round((fpsRef.current.frames * 1000) / (now - fpsRef.current.lastTime)));
      fpsRef.current.frames = 0;
      fpsRef.current.lastTime = now;
    }

    drawGrid(ctx, bounds, w, h);
    drawTrafficLights(ctx, data.traffic_lights, bounds, w, h);
    drawPedestrians(ctx, data.pedestrians, bounds, w, h);
    drawVehicles(ctx, data.vehicles, bounds, w, h);

    animationFrameRef.current = requestAnimationFrame(render);
  };

  // -- Setup --
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    };
    resize();

    // Mouse hover
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setMousePos({ x: mx, y: my });

      const data = currentDataRef.current;
      const bounds = boundsRef.current;
      if (!data || !bounds) {
        setHoveredVehicle(null);
        setHoveredPedestrian(null);
        return;
      }

      // Check vehicles first (larger hit area)
      for (const v of data.vehicles) {
        const p = worldToScreen(v.position.x, v.position.y, bounds, canvas.width, canvas.height);
        if (Math.hypot(mx - p.x, my - p.y) <= 14) {
          setHoveredVehicle(v);
          setHoveredPedestrian(null);
          return;
        }
      }

      // Check pedestrians
      for (const ped of data.pedestrians) {
        const p = worldToScreen(ped.position.x, ped.position.y, bounds, canvas.width, canvas.height);
        if (Math.hypot(mx - p.x, my - p.y) <= 10) {
          setHoveredPedestrian(ped);
          setHoveredVehicle(null);
          return;
        }
      }

      setHoveredVehicle(null);
      setHoveredPedestrian(null);
    };

    canvas.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('resize', resize);
    animationFrameRef.current = requestAnimationFrame(render);

    // WebSocket
    let fullWsUrl = wsUrl;
    if (!wsUrl.includes('/ws')) {
      const proto = wsUrl.startsWith('https') ? 'wss' : 'ws';
      const host = wsUrl.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').replace(/:\d+$/, '');
      const port = wsUrl.match(/:(\d+)$/)?.[1] || '8000';
      fullWsUrl = `${proto}://${host}:${port}/ws`;
    }

    const ws = new WebSocket(fullWsUrl);
    wsRef.current = ws;

    ws.onopen = () => setIsConnected(true);

    ws.onmessage = (event) => {
      try {
        const data: SnapshotData = JSON.parse(event.data);
        if (data && typeof data === 'object' && 'vehicles' in data) {
          currentDataRef.current = data;
          boundsRef.current = calculateBounds(data.vehicles, data.pedestrians || []);
          setMetrics(data.metrics);
        }
      } catch {
        // ignore parse errors (pings, etc.)
      }
    };

    ws.onerror = () => setIsConnected(false);
    ws.onclose = () => setIsConnected(false);

    return () => {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', handleMouseMove);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      ws.close();
    };
  }, [wsUrl]);

  return (
    <div className="relative h-full w-full" style={{ background: THEME.canvasBg }}>
      <canvas ref={canvasRef} className="h-full w-full" />

      {/* ---- Status bar (top left) ---- */}
      <div
        className="absolute top-3 left-3 flex items-center gap-3 rounded-xl px-4 py-2.5"
        style={{ background: THEME.overlayBg, border: THEME.overlayBorder }}
      >
        <div className="flex items-center gap-2">
          <div
            className="h-2 w-2 rounded-full"
            style={{ background: isConnected ? '#22c55e' : '#ef4444' }}
          />
          <span className="text-xs font-medium" style={{ color: THEME.textSecondary }}>
            {isConnected ? 'Live' : 'Disconnected'}
          </span>
        </div>
        <div style={{ width: 1, height: 16, background: THEME.divider }} />
        <div className="flex items-center gap-1.5">
          <Car size={12} style={{ color: THEME.textMuted }} />
          <span className="text-xs" style={{ color: THEME.textPrimary }}>
            {metrics?.total_vehicles ?? 0}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Users size={12} style={{ color: THEME.textMuted }} />
          <span className="text-xs" style={{ color: THEME.textPrimary }}>
            {metrics?.total_pedestrians ?? 0}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Circle size={10} style={{ color: THEME.textMuted }} />
          <span className="text-xs" style={{ color: THEME.textPrimary }}>
            {currentDataRef.current?.traffic_lights?.length ?? 0}
          </span>
        </div>
        <div style={{ width: 1, height: 16, background: THEME.divider }} />
        <div className="flex items-center gap-1.5">
          <Gauge size={12} style={{ color: THEME.textMuted }} />
          <span className="text-xs" style={{ color: THEME.textPrimary }}>{fps} fps</span>
        </div>
      </div>

      {/* ---- Metrics bar (top right) ---- */}
      {metrics && metrics.total_vehicles > 0 && (
        <div
          className="absolute top-3 right-3 flex items-center gap-3 rounded-xl px-4 py-2.5"
          style={{ background: THEME.overlayBg, border: THEME.overlayBorder }}
        >
          <div className="text-center">
            <div className="text-xs" style={{ color: THEME.textMuted }}>Avg</div>
            <div className="text-xs font-medium" style={{ color: THEME.textPrimary }}>
              {metrics.average_speed_kmh.toFixed(0)} km/h
            </div>
          </div>
          <div style={{ width: 1, height: 24, background: THEME.divider }} />
          <div className="text-center">
            <div className="text-xs" style={{ color: THEME.textMuted }}>Max</div>
            <div className="text-xs font-medium" style={{ color: THEME.textPrimary }}>
              {metrics.max_speed_kmh.toFixed(0)} km/h
            </div>
          </div>
          <div style={{ width: 1, height: 24, background: THEME.divider }} />
          <div className="text-center">
            <div className="text-xs" style={{ color: THEME.textMuted }}>Collisions</div>
            <div
              className="text-xs font-medium"
              style={{ color: metrics.total_collisions > 0 ? THEME.red : THEME.green }}
            >
              {metrics.total_collisions}
            </div>
          </div>
          <div style={{ width: 1, height: 24, background: THEME.divider }} />
          <div className="text-center">
            <div className="text-xs" style={{ color: THEME.textMuted }}>Density</div>
            <div className="text-xs font-medium" style={{ color: THEME.textPrimary }}>
              {metrics.traffic_density.toFixed(1)}
            </div>
          </div>
        </div>
      )}

      {/* ---- Legend (bottom right) ---- */}
      <div
        className="absolute right-3 bottom-3 rounded-xl px-4 py-3"
        style={{ background: THEME.overlayBg, border: THEME.overlayBorder }}
      >
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full" style={{ background: LIGHT_COLORS.red }} />
            <span className="text-xs" style={{ color: THEME.textSecondary }}>Red light</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full" style={{ background: LIGHT_COLORS.green }} />
            <span className="text-xs" style={{ color: THEME.textSecondary }}>Green light</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full" style={{ background: LIGHT_COLORS.yellow }} />
            <span className="text-xs" style={{ color: THEME.textSecondary }}>Yellow light</span>
          </div>
          <div style={{ height: 1, background: THEME.divider, margin: '4px 0' }} />
          <div className="flex items-center gap-2">
            <div
              className="h-3 w-8 rounded-full"
              style={{ background: 'linear-gradient(to right, #38bdf8, #f59e0b)' }}
            />
            <span className="text-xs" style={{ color: THEME.textSecondary }}>Slow / Fast</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full" style={{ background: '#2dd4bf' }} />
            <span className="text-xs" style={{ color: THEME.textSecondary }}>Pedestrian</span>
          </div>
        </div>
      </div>

      {/* ---- Vehicle hover tooltip ---- */}
      {hoveredVehicle && (
        <div
          className="pointer-events-none absolute z-50 rounded-xl"
          style={{
            left: mousePos.x + 16,
            top: mousePos.y + 16,
            background: THEME.overlayBg,
            border: THEME.overlayBorder,
            padding: '12px 16px',
            minWidth: 200,
          }}
        >
          <div
            className="mb-2 flex items-center justify-between pb-2"
            style={{ borderBottom: THEME.overlayBorder }}
          >
            <span className="text-xs font-semibold" style={{ color: THEME.textPrimary }}>
              Vehicle #{hoveredVehicle.id}
            </span>
            <span
              className="rounded-full px-1.5 py-0.5"
              style={{
                fontSize: '10px',
                background: hoveredVehicle.autopilot_enabled ? THEME.greenBg : THEME.redBg,
                color: hoveredVehicle.autopilot_enabled ? THEME.green : THEME.red,
              }}
            >
              {hoveredVehicle.autopilot_enabled ? 'autopilot' : 'manual'}
            </span>
          </div>
          <div className="space-y-1.5">
            {[
              { label: 'Type', value: hoveredVehicle.type.split('.').pop() },
              { label: 'Speed', value: `${hoveredVehicle.velocity.speed_kmh.toFixed(1)} km/h`, color: THEME.green },
              { label: 'Position', value: `(${hoveredVehicle.position.x.toFixed(0)}, ${hoveredVehicle.position.y.toFixed(0)})` },
              { label: 'Distance', value: `${hoveredVehicle.distance_traveled?.toFixed(0) || 0}m` },
              { label: 'Throttle', value: `${((hoveredVehicle.control?.throttle || 0) * 100).toFixed(0)}%` },
              { label: 'Brake', value: `${((hoveredVehicle.control?.brake || 0) * 100).toFixed(0)}%` },
              { label: 'Gear', value: `${hoveredVehicle.control?.gear ?? 0}` },
            ].map((row) => (
              <div key={row.label} className="flex justify-between">
                <span className="text-xs" style={{ color: THEME.textMuted }}>{row.label}</span>
                <span className="text-xs" style={{ color: row.color || THEME.textPrimary }}>{row.value}</span>
              </div>
            ))}
            {hoveredVehicle.sensors?.last_collision && (
              <div
                className="mt-1 rounded px-2 py-1"
                style={{ background: THEME.redBg }}
              >
                <span className="text-xs" style={{ color: THEME.red }}>
                  Collision: {hoveredVehicle.sensors.last_collision.other_actor}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- Pedestrian hover tooltip ---- */}
      {hoveredPedestrian && !hoveredVehicle && (
        <div
          className="pointer-events-none absolute z-50 rounded-xl"
          style={{
            left: mousePos.x + 16,
            top: mousePos.y + 16,
            background: THEME.overlayBg,
            border: THEME.overlayBorder,
            padding: '12px 16px',
            minWidth: 160,
          }}
        >
          <div
            className="mb-2 pb-2"
            style={{ borderBottom: THEME.overlayBorder }}
          >
            <span className="text-xs font-semibold" style={{ color: THEME.textPrimary }}>
              Pedestrian #{hoveredPedestrian.id}
            </span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <span className="text-xs" style={{ color: THEME.textMuted }}>Speed</span>
              <span className="text-xs" style={{ color: '#2dd4bf' }}>
                {hoveredPedestrian.velocity.speed.toFixed(1)} m/s
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs" style={{ color: THEME.textMuted }}>Position</span>
              <span className="text-xs" style={{ color: THEME.textPrimary }}>
                ({hoveredPedestrian.position.x.toFixed(0)}, {hoveredPedestrian.position.y.toFixed(0)})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs" style={{ color: THEME.textMuted }}>Heading</span>
              <span className="text-xs" style={{ color: THEME.textPrimary }}>
                {hoveredPedestrian.heading.toFixed(0)}deg
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ---- Connection error overlay ---- */}
      {!isConnected && (
        <div
          className="absolute bottom-3 left-3 flex items-center gap-2 rounded-xl px-4 py-2.5"
          style={{ background: THEME.redBg, border: '1px solid rgba(239,68,68,0.15)' }}
        >
          <AlertCircle size={14} style={{ color: THEME.red }} />
          <span className="text-xs" style={{ color: THEME.red }}>
            No connection to snapshot service
          </span>
        </div>
      )}
    </div>
  );
}
