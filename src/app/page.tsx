'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import DetailPanel from '@/components/DetailPanel';
import { AlertToast, Legend, MapNotice } from '@/components/Overlays';
import ReplayBar from '@/components/ReplayBar';
import Sidebar from '@/components/Sidebar';
import StatusBar from '@/components/StatusBar';
import { usePoller } from '@/hooks/usePoller';
import { useTraffic } from '@/store/traffic';

// Leaflet touches `window` on import, so the map is client-only.
const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => <div className="map-notice">Loading map…</div>,
});

export default function Home() {
  useEffect(() => {
    void useTraffic.getState().hydrate();
  }, []);
  usePoller();

  return (
    <div className="app">
      <StatusBar />
      <div className="body">
        <Sidebar />
        <main className="main">
          <MapView />
          <MapNotice />
          <Legend />
          <AlertToast />
          <ReplayBar />
          <DetailPanel />
        </main>
      </div>
    </div>
  );
}
