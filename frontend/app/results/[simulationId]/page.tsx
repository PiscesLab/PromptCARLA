'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import MapVisualization from '../../_components/map_visualization';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Car,
  Users,
  Activity,
  Camera,
  Map,
  Play,
  Pause,
  RotateCcw,
  AlertCircle,
  LayoutDashboard,
} from 'lucide-react';

// -- Types --
interface SimulationData {
  simulation_id: string;
  config: Record<string, unknown>;
  model_name: string;
  simulator_status: string;
  error?: string;
}

interface MetricCardProps {
  icon: React.ReactNode;
  bg: string;
  label: string;
  value: string | number;
}

function MetricCard({ icon, bg, label, value }: MetricCardProps) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${bg}`}>{icon}</div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold text-card-foreground">{value}</p>
        </div>
      </div>
    </Card>
  );
}

// -- Syntax highlight for config display --
function syntaxHighlight(json: string | object): string {
  if (typeof json !== 'string') json = JSON.stringify(json, null, 2);
  return json.replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match: string) => {
      let cls = 'text-amber-300';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'text-sky-400' : 'text-emerald-400';
      } else if (/true|false/.test(match)) {
        cls = 'text-violet-400';
      } else if (/null/.test(match)) {
        cls = 'text-rose-400';
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

const MODEL_COLORS: Record<string, string> = {
  'gemini-2.5-flash': '#4285f4',
  'claude-sonnet-4': '#d4a27f',
  'gpt-4.1-mini': '#10a37f',
  'deepseek-v3': '#7c5cfc',
};

export default function ResultsPage() {
  const params = useParams<{ simulationId?: string }>();
  const router = useRouter();
  const [simData, setSimData] = useState<SimulationData | null>(null);
  const [loading, setLoading] = useState(true);

  // Live dashboard state
  const [liveSnapshot, setLiveSnapshot] = useState<any>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<any>(null);
  const [isLive, setIsLive] = useState(true);
  const [cameraFeed, setCameraFeed] = useState<any>(null);
  const [connectionError, setConnectionError] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const NODE_IP = process.env.NEXT_PUBLIC_NODE_IP || 'localhost';
  const SNAPSHOT_PORT = process.env.NEXT_PUBLIC_SNAPSHOT_PORT || '8000';
  const WS_URL = `ws://${NODE_IP}:${SNAPSHOT_PORT}/ws`;
  const API_URL_SIM = `http://${NODE_IP}:${SNAPSHOT_PORT}`;

  // Load simulation data from sessionStorage
  useEffect(() => {
    const stored = sessionStorage.getItem('simulationResult');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setSimData(parsed);
      } catch {
        console.error('Failed to parse simulation result');
      }
    }
    setLoading(false);
  }, []);

  // WebSocket for live dashboard
  useEffect(() => {
    if (!isLive) return;
    const connectWebSocket = () => {
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;
        ws.onopen = () => setConnectionError(false);
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data !== 'ping' && typeof data === 'object') setLiveSnapshot(data);
          } catch {
            // ignore parse errors
          }
        };
        ws.onerror = () => setConnectionError(true);
        ws.onclose = () => {
          setConnectionError(true);
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000);
        };
      } catch {
        setConnectionError(true);
      }
    };
    connectWebSocket();
    return () => {
      wsRef.current?.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [isLive, WS_URL]);

  // Camera feed for selected vehicle
  useEffect(() => {
    if (!selectedVehicle) return;
    const fetchCamera = async () => {
      try {
        const res = await fetch(`${API_URL_SIM}/snapshot/camera/${selectedVehicle.id}/front_view`);
        if (res.ok) setCameraFeed(await res.json());
      } catch {
        // camera not available
      }
    };
    fetchCamera();
    const interval = setInterval(fetchCamera, 1000);
    return () => clearInterval(interval);
  }, [selectedVehicle, API_URL_SIM]);

  const toggleLive = () => setIsLive(!isLive);
  const resetView = () => {
    setSelectedVehicle(null);
    setCameraFeed(null);
  };

  const simulationId = params?.simulationId || simData?.simulation_id || 'unknown';
  const config = simData?.config || {};
  const modelName = simData?.model_name || 'unknown';
  const modelColor = MODEL_COLORS[modelName] || 'hsl(var(--muted-foreground))';
  const metrics = liveSnapshot?.metrics || {};
  const vehicles = liveSnapshot?.vehicles || [];

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          <span className="text-muted-foreground">Loading simulation...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background text-foreground">
      <div className="mx-auto max-w-7xl p-6">
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="mb-6 w-full justify-start">
            <TabsTrigger value="overview" className="gap-2">
              <LayoutDashboard className="h-4 w-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="map" className="gap-2">
              <Map className="h-4 w-4" />
              Real-time Map
            </TabsTrigger>
            <TabsTrigger value="dashboard" className="gap-2">
              <Activity className="h-4 w-4" />
              Live Dashboard
            </TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              {/* Simulation Panel */}
              <Card className="p-6">
                <h2 className="mb-4 text-xl font-semibold text-card-foreground">Simulation</h2>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">ID:</span>
                    <span className="font-mono text-card-foreground">{simulationId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Model:</span>
                    <span style={{ color: modelColor }}>{modelName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status:</span>
                    <Badge variant="secondary">
                      {simData?.simulator_status === 'success' ? 'Running' : 'Pending'}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Weather:</span>
                    <span className="text-card-foreground">{(config.weather as string) || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Map:</span>
                    <span className="text-card-foreground">{(config.map as string) || 'N/A'}</span>
                  </div>
                </div>
              </Card>

              {/* Config JSON Panel */}
              <Card className="overflow-hidden">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full" style={{ background: modelColor }} />
                    <h2 className="text-sm font-semibold" style={{ color: modelColor }}>
                      {modelName}
                    </h2>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      simData?.simulator_status === 'success'
                        ? 'border-green-500/30 bg-green-500/10 text-green-400'
                        : 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400'
                    }
                  >
                    {simData?.simulator_status === 'success'
                      ? 'Applied to CARLA'
                      : simData?.simulator_status || 'pending'}
                  </Badge>
                </div>
                <pre
                  className="overflow-x-auto bg-muted/40 p-4 text-xs leading-relaxed"
                  style={{ fontFamily: "var(--font-geist-mono, 'Geist Mono', monospace)" }}
                  dangerouslySetInnerHTML={{ __html: syntaxHighlight(config) }}
                />
              </Card>

              {/* Config Panel */}
              <Card className="p-6">
                <h2 className="mb-4 text-xl font-semibold text-card-foreground">Configuration</h2>
                <div className="space-y-3">
                  <div>
                    <div className="text-sm text-muted-foreground">Vehicles</div>
                    <div className="text-2xl font-bold text-card-foreground">
                      {(config.number_of_vehicles as number) ?? 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">Pedestrians</div>
                    <div className="text-2xl font-bold text-card-foreground">
                      {(config.number_of_pedestrians as number) ?? 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">Visibility</div>
                    <div className="text-2xl font-bold text-card-foreground">
                      {config.visibility != null ? `${config.visibility}%` : 'N/A'}
                    </div>
                  </div>
                </div>
              </Card>

              {/* Metrics Panel */}
              <Card className="p-6">
                <h2 className="mb-4 text-xl font-semibold text-card-foreground">Live Metrics</h2>
                {Object.keys(metrics).length > 0 ? (
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Avg Speed:</span>
                      <span className="font-semibold text-card-foreground">
                        {metrics.average_speed_kmh?.toFixed(0) || 0} km/h
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Collisions:</span>
                      <span className="font-semibold text-card-foreground">
                        {metrics.total_collisions || 0}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Traffic Density:</span>
                      <span className="font-semibold text-card-foreground">
                        {metrics.traffic_density?.toFixed(2) || 0}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-32 items-center justify-center text-center text-sm text-muted-foreground">
                    Waiting for live data from CARLA...
                  </div>
                )}
              </Card>
            </div>
          </TabsContent>

          {/* Real-time Map Tab */}
          <TabsContent value="map">
            <Card className="overflow-hidden">
              <div className="border-b p-4">
                <h2 className="text-xl font-semibold text-card-foreground">Real-time Map</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Live visualization of vehicles, roads, and traffic lights
                </p>
              </div>
              <div className="w-full" style={{ height: '700px' }}>
                <MapVisualization simulationId={simulationId} />
              </div>
            </Card>
          </TabsContent>

          {/* Live Dashboard Tab */}
          <TabsContent value="dashboard">
            {!liveSnapshot ? (
              <div className="flex h-96 items-center justify-center">
                <div className="space-y-4 text-center">
                  {connectionError ? (
                    <>
                      <AlertCircle className="mx-auto h-16 w-16 text-destructive" />
                      <p className="text-muted-foreground">Unable to connect to simulation service</p>
                      <p className="text-sm text-muted-foreground/60">
                        Make sure the snapshot service is running at {NODE_IP}:{SNAPSHOT_PORT}
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="mx-auto h-16 w-16 animate-spin rounded-full border-4 border-muted border-t-foreground" />
                      <p className="text-muted-foreground">Connecting to simulation...</p>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Control Bar */}
                <Card className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <Button onClick={toggleLive} variant={isLive ? 'default' : 'outline'} className="gap-2">
                      {isLive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      {isLive ? 'Pause' : 'Resume'}
                    </Button>
                    <Button onClick={resetView} variant="outline" className="gap-2">
                      <RotateCcw className="h-4 w-4" />
                      Reset View
                    </Button>
                    {connectionError && (
                      <div className="flex items-center gap-2 text-sm text-destructive">
                        <AlertCircle className="h-4 w-4" />
                        Connection lost - retrying...
                      </div>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Last updated:{' '}
                    {liveSnapshot.timestamp
                      ? new Date(liveSnapshot.timestamp * 1000).toLocaleTimeString()
                      : 'N/A'}
                  </div>
                </Card>

                {/* Metrics Overview */}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                  <MetricCard
                    icon={<Car className="h-5 w-5 text-chart-2" />}
                    bg="bg-chart-2/20"
                    label="Vehicles"
                    value={metrics.total_vehicles || 0}
                  />
                  <MetricCard
                    icon={<Users className="h-5 w-5 text-chart-4" />}
                    bg="bg-chart-4/20"
                    label="Pedestrians"
                    value={metrics.total_pedestrians || 0}
                  />
                  <MetricCard
                    icon={<Activity className="h-5 w-5 text-chart-3" />}
                    bg="bg-chart-3/20"
                    label="Avg Speed"
                    value={
                      metrics.average_speed_kmh
                        ? `${metrics.average_speed_kmh.toFixed(0)} km/h`
                        : '0 km/h'
                    }
                  />
                  <MetricCard
                    icon={<Activity className="h-5 w-5 text-destructive" />}
                    bg="bg-destructive/20"
                    label="Collisions"
                    value={metrics.total_collisions || 0}
                  />
                </div>

                {/* Vehicles list */}
                {vehicles.length > 0 && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {vehicles.map((v: any) => (
                      <Card
                        key={v.id}
                        onClick={() => setSelectedVehicle(v)}
                        className={`cursor-pointer p-4 transition hover:shadow-md ${
                          selectedVehicle?.id === v.id ? 'ring-2 ring-ring' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-semibold text-card-foreground">Vehicle #{v.id}</p>
                            <p className="text-xs text-muted-foreground">
                              {v.type?.split('.').pop() || 'Unknown'}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-lg font-bold text-card-foreground">
                              {v.velocity?.speed_kmh?.toFixed(0) || 0}
                            </p>
                            <p className="text-xs text-muted-foreground">km/h</p>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}

                {/* Selected vehicle detail */}
                {selectedVehicle && (
                  <Card className="p-6">
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <p className="text-xl font-semibold text-card-foreground">
                          Vehicle #{selectedVehicle.id}
                        </p>
                        <p className="text-sm text-muted-foreground">{selectedVehicle.type}</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setSelectedVehicle(null)}>
                        Close
                      </Button>
                    </div>
                    <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
                      <div>
                        <p className="text-sm text-muted-foreground">Speed</p>
                        <p className="text-lg font-bold text-card-foreground">
                          {selectedVehicle.velocity?.speed_kmh?.toFixed(1) || 0} km/h
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Distance</p>
                        <p className="text-lg font-bold text-card-foreground">
                          {selectedVehicle.distance_traveled?.toFixed(0) || 0} m
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Position</p>
                        <p className="text-sm font-medium text-card-foreground">
                          x: {selectedVehicle.position?.x?.toFixed(0) || 0}
                        </p>
                        <p className="text-sm font-medium text-card-foreground">
                          y: {selectedVehicle.position?.y?.toFixed(0) || 0}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Heading</p>
                        <p className="text-lg font-bold text-card-foreground">
                          {selectedVehicle.rotation?.yaw?.toFixed(0) || 0}deg
                        </p>
                      </div>
                    </div>

                    {cameraFeed ? (
                      <div className="flex flex-col items-center">
                        <img
                          src={`data:image/jpeg;base64,${cameraFeed.data}`}
                          alt="Camera View"
                          className="w-full max-w-2xl rounded-lg shadow-md"
                        />
                        <p className="mt-2 text-xs text-muted-foreground">
                          Camera: {cameraFeed.type} |{' '}
                          {cameraFeed.timestamp
                            ? new Date(cameraFeed.timestamp * 1000).toLocaleTimeString()
                            : 'N/A'}
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-lg bg-muted py-10 text-center text-muted-foreground">
                        <Camera className="mx-auto mb-2 h-8 w-8 opacity-50" />
                        <p>Loading camera feed...</p>
                      </div>
                    )}
                  </Card>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
