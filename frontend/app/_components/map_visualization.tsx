'use client';
import { useEffect, useRef, useState } from 'react';
import { Car, Users, Gauge, AlertCircle, Wifi, WifiOff, MapPin, Activity } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

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

// ===================== Colors =====================
const COLOR = {
  bg:           0xfafafa,
  road:         0xd1d5db,
  vehicle:      0x2563eb,
  vehicleFast:  0xd97706,
  vehicleFront: 0xffffff,
  pedestrian:   0x059669,
};

const LIGHT_COLOR: Record<string, number> = {
  red:     0xef4444,
  yellow:  0xeab308,
  green:   0x22c55e,
  off:     0xd1d5db,
  unknown: 0x9ca3af,
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

function worldToPixi(wx: number, wy: number, b: MapBounds, w: number, h: number) {
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
  const containerRef = useRef<HTMLDivElement>(null);
  const pixiAppRef = useRef<any>(null);
  const layersRef = useRef<{ roads: any; lights: any; pedestrians: any; vehicles: any } | null>(null);
  const vehicleGfxRef = useRef<Map<number, any>>(new Map());
  const pedestrianGfxRef = useRef<Map<number, any>>(new Map());
  const lightGfxRef = useRef<Map<number, any>>(new Map());
  const boundsRef = useRef<MapBounds | null>(null);
  const mapDataRef = useRef<MapData | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [mapName, setMapName] = useState<string | null>(null);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    const IP = process.env.NEXT_PUBLIC_NODE_IP || 'localhost';
    const PORT = process.env.NEXT_PUBLIC_SNAPSHOT_PORT || '8000';
    const API = `http://${IP}:${PORT}`;

    let destroyed = false;
    let ws: WebSocket | null = null;
    let handleResize: (() => void) | null = null;

    const drawRoads = (app: any, PIXI: any) => {
      const roads = mapDataRef.current?.roads ?? [];
      const b = boundsRef.current;
      const layer = layersRef.current?.roads;
      if (!layer || !b || roads.length === 0) return;
      const W = app.renderer.width;
      const H = app.renderer.height;
      layer.clear();
      layer.setStrokeStyle({ width: 3, color: COLOR.road, cap: 'round', join: 'round' });
      roads.forEach(road => {
        const s = worldToPixi(road.start.x, road.start.y, b, W, H);
        const e = worldToPixi(road.end.x,   road.end.y,   b, W, H);
        layer.moveTo(s.x, s.y).lineTo(e.x, e.y);
      });
      layer.stroke();
    };

    const init = async () => {
      const PIXI = await import('pixi.js');
      if (destroyed || !containerRef.current) return;

      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;

      const app = new PIXI.Application();
      await app.init({
        width: w,
        height: h,
        background: COLOR.bg,
        antialias: true,
        preference: 'webgpu',
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });

      if (destroyed) { app.destroy(true); return; }

      containerRef.current.appendChild(app.canvas);
      pixiAppRef.current = app;

      const roadLayer = new PIXI.Graphics();
      const lightLayer = new PIXI.Container();
      const pedLayer   = new PIXI.Container();
      const vehLayer   = new PIXI.Container();
      app.stage.addChild(roadLayer, lightLayer, pedLayer, vehLayer);
      layersRef.current = { roads: roadLayer, lights: lightLayer, pedestrians: pedLayer, vehicles: vehLayer };

      // FPS counter
      app.ticker.add(() => setFps(Math.round(app.ticker.FPS)));

      // Resize
      handleResize = () => {
        if (!containerRef.current || !pixiAppRef.current) return;
        const nw = containerRef.current.clientWidth;
        const nh = containerRef.current.clientHeight;
        pixiAppRef.current.renderer.resize(nw, nh);
        drawRoads(pixiAppRef.current, PIXI);
      };
      window.addEventListener('resize', handleResize);

      // Fetch road topology
      fetch(`${API}/map_data`)
        .then(r => r.json())
        .then((data: MapData) => {
          if (destroyed) return;
          mapDataRef.current = data;
          boundsRef.current = boundsFromRoads(data.roads);
          setMapName(data.map_name);
          drawRoads(app, PIXI);
        })
        .catch(() => {});

      // WebSocket
      ws = new WebSocket(`ws://${IP}:${PORT}/ws`);
      ws.onopen = () => setIsConnected(true);
      ws.onclose = () => setIsConnected(false);

      ws.onmessage = (e) => {
        if (destroyed) return;
        try {
          const data: SnapshotData = JSON.parse(e.data);
          setMetrics(data.metrics);

          if (!mapDataRef.current) {
            boundsRef.current = boundsFromActors(data.vehicles, data.pedestrians, data.traffic_lights);
          }

          const b = boundsRef.current;
          if (!b || !layersRef.current || !pixiAppRef.current) return;

          const W = pixiAppRef.current.renderer.width;
          const H = pixiAppRef.current.renderer.height;

          // -- Vehicles --
          const seenV = new Set<number>();
          data.vehicles.forEach(v => {
            seenV.add(v.id);
            const pos = worldToPixi(v.position.x, v.position.y, b, W, H);
            const fast = v.velocity.speed_kmh > 40;

            let gfx = vehicleGfxRef.current.get(v.id);
            if (!gfx) {
              gfx = new PIXI.Graphics();
              layersRef.current!.vehicles.addChild(gfx);
              vehicleGfxRef.current.set(v.id, gfx);
            }
            gfx.clear();
            gfx.roundRect(-5, -9, 10, 18, 2);
            gfx.fill(fast ? COLOR.vehicleFast : COLOR.vehicle);
            gfx.circle(0, -6, 2);
            gfx.fill(COLOR.vehicleFront);
            gfx.x = pos.x;
            gfx.y = pos.y;
            gfx.rotation = ((90 - v.rotation.yaw) * Math.PI) / 180;
          });
          vehicleGfxRef.current.forEach((gfx, id) => {
            if (!seenV.has(id)) {
              layersRef.current!.vehicles.removeChild(gfx);
              gfx.destroy();
              vehicleGfxRef.current.delete(id);
            }
          });

          // -- Pedestrians --
          const seenP = new Set<number>();
          data.pedestrians.forEach(p => {
            seenP.add(p.id);
            const pos = worldToPixi(p.position.x, p.position.y, b, W, H);
            let gfx = pedestrianGfxRef.current.get(p.id);
            if (!gfx) {
              gfx = new PIXI.Graphics();
              layersRef.current!.pedestrians.addChild(gfx);
              pedestrianGfxRef.current.set(p.id, gfx);
            }
            gfx.clear();
            gfx.circle(0, 0, 4);
            gfx.fill(COLOR.pedestrian);
            gfx.x = pos.x;
            gfx.y = pos.y;
          });
          pedestrianGfxRef.current.forEach((gfx, id) => {
            if (!seenP.has(id)) {
              layersRef.current!.pedestrians.removeChild(gfx);
              gfx.destroy();
              pedestrianGfxRef.current.delete(id);
            }
          });

          // -- Traffic lights --
          const seenL = new Set<number>();
          (data.traffic_lights || []).forEach(l => {
            seenL.add(l.id);
            const pos = worldToPixi(l.position.x, l.position.y, b, W, H);
            const col = LIGHT_COLOR[l.state] ?? LIGHT_COLOR.unknown;
            let gfx = lightGfxRef.current.get(l.id);
            if (!gfx) {
              gfx = new PIXI.Graphics();
              layersRef.current!.lights.addChild(gfx);
              lightGfxRef.current.set(l.id, gfx);
            }
            gfx.clear();
            gfx.circle(0, 0, 5);
            gfx.fill(col);
            gfx.x = pos.x;
            gfx.y = pos.y;
          });
          lightGfxRef.current.forEach((gfx, id) => {
            if (!seenL.has(id)) {
              layersRef.current!.lights.removeChild(gfx);
              gfx.destroy();
              lightGfxRef.current.delete(id);
            }
          });

        } catch {}
      };
    };

    init();

    return () => {
      destroyed = true;
      if (ws) ws.close();
      if (handleResize) window.removeEventListener('resize', handleResize);
      if (pixiAppRef.current) {
        pixiAppRef.current.destroy(true, { children: true });
        pixiAppRef.current = null;
      }
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl bg-[#fafafa]">
      <div ref={containerRef} className="h-full w-full" />

      {/* Top bar */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={`pointer-events-auto gap-1.5 bg-white/90 shadow-sm ${
              isConnected ? 'border-green-200 text-green-600' : 'border-red-200 text-red-500'
            }`}
          >
            {isConnected ? <Wifi size={11} /> : <WifiOff size={11} />}
            {isConnected ? 'Live' : 'Disconnected'}
          </Badge>
          {mapName && (
            <Badge variant="outline" className="gap-1.5 bg-white/90 shadow-sm">
              <MapPin size={11} />
              {mapName}
            </Badge>
          )}
        </div>
        <Badge variant="outline" className="gap-1.5 bg-white/90 font-mono shadow-sm">
          <Activity size={11} />
          {fps} fps
        </Badge>
      </div>

      {/* Metrics panel */}
      {metrics && (
        <Card className="absolute right-3 top-10 w-44 overflow-hidden bg-white/95 p-0 shadow-md">
          <div className="border-b px-3 py-2">
            <p className="text-xs font-semibold text-foreground">Live Metrics</p>
          </div>
          <div className="divide-y">
            {[
              { icon: <Car size={11} />,         label: 'Vehicles',    value: metrics.total_vehicles },
              { icon: <Users size={11} />,        label: 'Pedestrians', value: metrics.total_pedestrians },
              { icon: <Gauge size={11} />,        label: 'Avg Speed',   value: `${metrics.average_speed_kmh.toFixed(1)} km/h` },
              { icon: <Gauge size={11} />,        label: 'Max Speed',   value: `${metrics.max_speed_kmh.toFixed(1)} km/h` },
              ...(metrics.traffic_density != null
                ? [{ icon: <Activity size={11} />, label: 'Density', value: metrics.traffic_density.toFixed(1) }]
                : []),
              { icon: <AlertCircle size={11} />,  label: 'Collisions',  value: metrics.total_collisions, highlight: metrics.total_collisions > 0 },
            ].map(({ icon, label, value, highlight }) => (
              <div key={label} className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  {icon}
                  <span className="text-xs">{label}</span>
                </div>
                <span className={`text-xs font-semibold tabular-nums ${highlight ? 'text-destructive' : 'text-foreground'}`}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Legend */}
      <div className="absolute bottom-3 left-3">
        <Card className="flex items-center gap-3 bg-white/95 px-3 py-2 shadow-sm">
          {[
            { color: '#2563eb', label: 'Vehicle',    shape: 'rect' },
            { color: '#d97706', label: '>40 km/h',   shape: 'rect' },
            { color: '#059669', label: 'Pedestrian', shape: 'circle' },
          ].map(({ color, label, shape }, i) => (
            <div key={label} className="flex items-center gap-1.5">
              {i > 0 && <Separator orientation="vertical" className="h-3" />}
              <div
                className={shape === 'circle' ? 'h-2.5 w-2.5 rounded-full' : 'h-2.5 w-4 rounded-sm'}
                style={{ background: color }}
              />
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
          <Separator orientation="vertical" className="h-3" />
          <div className="flex items-center gap-1.5">
            <div className="flex gap-0.5">
              {['#22c55e', '#eab308', '#ef4444'].map(c => (
                <div key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
              ))}
            </div>
            <span className="text-xs text-muted-foreground">Lights</span>
          </div>
        </Card>
      </div>
    </div>
  );
}
