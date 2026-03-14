'use client';

import { useState, useEffect } from 'react';
import { Car } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ModeToggle } from '@/components/mode-toggle';

const NODE_IP = process.env.NEXT_PUBLIC_NODE_IP || 'localhost';
const SNAPSHOT_PORT = process.env.NEXT_PUBLIC_SNAPSHOT_PORT || '8000';
const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  `http://${process.env.NEXT_PUBLIC_NODE_IP}:${process.env.NEXT_PUBLIC_API_PORT || '8500'}`;

export function PromptCarlaHeader() {
  const [status, setStatus] = useState({ agent: 'loading', simulator: 'loading' });

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const agentRes = await fetch(`${API_URL}/health`);
        const agentStatus = agentRes.ok ? 'online' : 'offline';
        const simRes = await fetch(`http://${NODE_IP}:${SNAPSHOT_PORT}/health`);
        const simStatus = simRes.ok ? 'online' : 'offline';
        setStatus({ agent: agentStatus, simulator: simStatus });
      } catch {
        setStatus({ agent: 'offline', simulator: 'offline' });
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="flex items-center justify-between border-b px-6 py-3">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-70">
          <Car size={20} className="text-muted-foreground" />
          <span className="text-sm font-semibold tracking-wide text-foreground">PromptCarla</span>
        </Link>
        <Separator orientation="vertical" className="h-4" />
        <div className="flex gap-2">
          {(['agent', 'simulator'] as const).map((service) => (
            <Badge
              key={service}
              variant="outline"
              className={`gap-1.5 capitalize ${
                status[service] === 'online'
                  ? 'border-green-500/30 text-green-400'
                  : 'border-destructive/30 text-destructive'
              }`}
            >
              <div
                className={`h-1.5 w-1.5 rounded-full ${
                  status[service] === 'online' ? 'bg-green-400' : 'bg-destructive'
                }`}
              />
              {service.charAt(0).toUpperCase() + service.slice(1)}
            </Badge>
          ))}
        </div>
      </div>
      <ModeToggle />
    </header>
  );
}
