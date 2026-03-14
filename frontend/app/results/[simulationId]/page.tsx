'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import MapVisualization from '../../_components/map_visualization';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
  ArrowLeft,
  Clock,
  Zap,
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
          <p className="text-muted-foreground text-sm">{label}</p>
          <p className="text-card-foreground text-2xl font-bold">{value}</p>
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
  const [snapshot, setSnapshot] = useState<string | null>(null);
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

  // Fetch snapshot for overview tab
  useEffect(() => {
    if (!simData) return;

    const fetchSnapshot = async () => {
      try {
        const response = await fetch(`${API_URL_SIM}/snapshot`);
        const data = await response.json();
        setSnapshot(data.snapshot);
      } catch {
        // Snapshot service not available
      }
    };

    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 5000);
    return () => clearInterval(interval);
  }, [simData, API_URL_SIM]);

  // WebSocket for live dashboard
  useEffect(() => {
    if (!isLive) return;

    const connectWebSocket = () => {
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnectionError(false);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data !== 'ping' && typeof data === 'object') {
              setLiveSnapshot(data);
            }
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
  const modelColor = MODEL_COLORS[modelName] || '#6b7280';
  const metrics = liveSnapshot?.metrics || {};
  const vehicles = liveSnapshot?.vehicles || [];
  const pedestrians = liveSnapshot?.pedestrians || [];
  const trafficLights = liveSnapshot?.traffic_lights || [];

  if (loading) {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        style={{ background: '#111116' }}
      >
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-gray-300" />
          <span style={{ color: '#9ca3af' }}>Loading simulation...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: '#111116', color: '#e5e7eb' }}>
      {/* Header */}
      <header
        className="flex items-center justify-between px-6 py-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
            <Car size={20} style={{ color: '#9ca3af' }} />
            <span
              className="text-sm font-semibold tracking-wide"
              style={{ color: '#d1d5db', letterSpacing: '0.04em' }}
            >
              MetisCity
            </span>
          </Link>
          <span style={{ color: '#374151' }}>/</span>
          <span className="text-xs" style={{ color: '#6b7280' }}>
            {simulationId}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => router.push('/')} className="gap-2">
          <ArrowLeft size={14} />
          Back to Chat
        </Button>
      </header>

      <div className="mx-auto max-w-7xl p-6">
        {/* Config summary bar */}
        <div
          className="mb-6 overflow-hidden rounded-xl"
          style={{
            background: '#0d1117',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div className="flex items-center gap-3">
              <div className="h-2.5 w-2.5 rounded-full" style={{ background: modelColor }} />
              <span className="text-sm font-semibold" style={{ color: modelColor }}>
                {modelName}
              </span>
              <span
                className="rounded-full px-2 py-0.5 text-xs"
                style={{
                  background:
                    simData?.simulator_status === 'success'
                      ? 'rgba(34,197,94,0.1)'
                      : 'rgba(234,179,8,0.1)',
                  color: simData?.simulator_status === 'success' ? '#4ade80' : '#facc15',
                }}
              >
                {simData?.simulator_status === 'success'
                  ? 'Applied to CARLA'
                  : simData?.simulator_status || 'pending'}
              </span>
            </div>
          </div>
          <pre
            className="overflow-x-auto p-4 text-xs leading-relaxed"
            style={{
              fontFamily: "var(--font-geist-mono, 'Geist Mono', monospace)",
            }}
            dangerouslySetInnerHTML={{ __html: syntaxHighlight(config) }}
          />
        </div>

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
                <h2 className="text-card-foreground mb-4 text-xl font-semibold">Simulation</h2>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">ID:</span>
                    <span className="text-card-foreground font-mono">{simulationId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Model:</span>
                    <span style={{ color: modelColor }}>{modelName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status:</span>
                    <span className="bg-chart-4/20 text-chart-4 rounded px-2 py-1 text-sm">
                      {simData?.simulator_status === 'success' ? 'Running' : 'Pending'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Weather:</span>
                    <span className="text-card-foreground">
                      {(config.weather as string) || 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Map:</span>
                    <span className="text-card-foreground">{(config.map as string) || 'N/A'}</span>
                  </div>
                </div>
              </Card>

              {/* Snapshot Panel */}
              <Card className="p-6">
                <h2 className="text-card-foreground mb-4 text-xl font-semibold">Snapshot</h2>
                {snapshot ? (
                  <img src={snapshot} alt="Simulation snapshot" className="w-full rounded-lg" />
                ) : (
                  <div className="text-muted-foreground flex h-48 items-center justify-center text-center text-sm">
                    No snapshot available. The CARLA snapshot service may not be running.
                  </div>
                )}
              </Card>

              {/* Config Panel */}
              <Card className="p-6">
                <h2 className="text-card-foreground mb-4 text-xl font-semibold">Configuration</h2>
                <div className="space-y-3">
                  <div>
                    <div className="text-muted-foreground text-sm">Vehicles</div>
                    <div className="text-card-foreground text-2xl font-bold">
                      {(config.number_of_vehicles as number) ?? 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-sm">Pedestrians</div>
                    <div className="text-card-foreground text-2xl font-bold">
                      {(config.number_of_pedestrians as number) ?? 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-sm">Visibility</div>
                    <div className="text-card-foreground text-2xl font-bold">
                      {config.visibility != null ? `${config.visibility}%` : 'N/A'}
                    </div>
                  </div>
                </div>
              </Card>

              {/* Metrics Panel */}
              <Card className="p-6">
                <h2 className="text-card-foreground mb-4 text-xl font-semibold">Live Metrics</h2>
                {Object.keys(metrics).length > 0 ? (
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Avg Speed:</span>
                      <span className="text-card-foreground font-semibold">
                        {metrics.average_speed_kmh?.toFixed(0) || 0} km/h
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Collisions:</span>
                      <span className="text-card-foreground font-semibold">
                        {metrics.total_collisions || 0}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Traffic Density:</span>
                      <span className="text-card-foreground font-semibold">
                        {metrics.traffic_density?.toFixed(2) || 0}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground flex h-32 items-center justify-center text-center text-sm">
                    Waiting for live data from CARLA...
                  </div>
                )}
              </Card>
            </div>
          </TabsContent>

          {/* Real-time Map Tab */}
          <TabsContent value="map">
            <Card className="overflow-hidden">
              <div className="border-border border-b p-4">
                <h2 className="text-card-foreground text-xl font-semibold">Real-time Map</h2>
                <p className="text-muted-foreground mt-1 text-sm">
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
                      <AlertCircle className="text-chart-1 mx-auto h-16 w-16" />
                      <p className="text-muted-foreground">
                        Unable to connect to simulation service
                      </p>
                      <p className="text-muted-foreground/60 text-sm">
                        Make sure the snapshot service is running at {NODE_IP}:{SNAPSHOT_PORT}
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="border-chart-1 mx-auto h-16 w-16 animate-spin rounded-full border-4 border-t-transparent" />
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
                    <Button
                      onClick={toggleLive}
                      variant={isLive ? 'default' : 'outline'}
                      className="gap-2"
                    >
                      {isLive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      {isLive ? 'Pause' : 'Resume'}
                    </Button>
                    <Button onClick={resetView} variant="outline" className="gap-2">
                      <RotateCcw className="h-4 w-4" />
                      Reset View
                    </Button>
                    {connectionError && (
                      <div className="text-chart-1 flex items-center gap-2 text-sm">
                        <AlertCircle className="h-4 w-4" />
                        Connection lost - retrying...
                      </div>
                    )}
                  </div>
                  <div className="text-muted-foreground text-sm">
                    Last updated:{' '}
                    {liveSnapshot.timestamp
                      ? new Date(liveSnapshot.timestamp * 1000).toLocaleTimeString()
                      : 'N/A'}
                  </div>
                </Card>

                {/* Metrics Overview */}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                  <MetricCard
                    icon={<Car className="text-chart-2 h-5 w-5" />}
                    bg="bg-chart-2/20"
                    label="Vehicles"
                    value={metrics.total_vehicles || 0}
                  />
                  <MetricCard
                    icon={<Users className="text-chart-4 h-5 w-5" />}
                    bg="bg-chart-4/20"
                    label="Pedestrians"
                    value={metrics.total_pedestrians || 0}
                  />
                  <MetricCard
                    icon={<Activity className="text-chart-3 h-5 w-5" />}
                    bg="bg-chart-3/20"
                    label="Avg Speed"
                    value={
                      metrics.average_speed_kmh
                        ? `${metrics.average_speed_kmh.toFixed(0)} km/h`
                        : '0 km/h'
                    }
                  />
                  <MetricCard
                    icon={<Activity className="text-destructive h-5 w-5" />}
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
                          selectedVehicle?.id === v.id ? 'ring-chart-1 ring-2' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-card-foreground font-semibold">Vehicle #{v.id}</p>
                            <p className="text-muted-foreground text-xs">
                              {v.type?.split('.').pop() || 'Unknown'}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-card-foreground text-lg font-bold">
                              {v.velocity?.speed_kmh?.toFixed(0) || 0}
                            </p>
                            <p className="text-muted-foreground text-xs">km/h</p>
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
                        <p className="text-card-foreground text-xl font-semibold">
                          Vehicle #{selectedVehicle.id}
                        </p>
                        <p className="text-muted-foreground text-sm">{selectedVehicle.type}</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setSelectedVehicle(null)}>
                        Close
                      </Button>
                    </div>
                    <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
                      <div>
                        <p className="text-muted-foreground text-sm">Speed</p>
                        <p className="text-card-foreground text-lg font-bold">
                          {selectedVehicle.velocity?.speed_kmh?.toFixed(1) || 0} km/h
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-sm">Distance</p>
                        <p className="text-card-foreground text-lg font-bold">
                          {selectedVehicle.distance_traveled?.toFixed(0) || 0} m
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-sm">Position</p>
                        <p className="text-card-foreground text-sm font-medium">
                          x: {selectedVehicle.position?.x?.toFixed(0) || 0}
                        </p>
                        <p className="text-card-foreground text-sm font-medium">
                          y: {selectedVehicle.position?.y?.toFixed(0) || 0}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-sm">Heading</p>
                        <p className="text-card-foreground text-lg font-bold">
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
                        <p className="text-muted-foreground mt-2 text-xs">
                          Camera: {cameraFeed.type} |{' '}
                          {cameraFeed.timestamp
                            ? new Date(cameraFeed.timestamp * 1000).toLocaleTimeString()
                            : 'N/A'}
                        </p>
                      </div>
                    ) : (
                      <div className="bg-muted text-muted-foreground rounded-lg py-10 text-center">
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
