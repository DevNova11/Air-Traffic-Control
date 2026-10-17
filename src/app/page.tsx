'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import DetailPanel from '@/components/DetailPanel';
import { Legend, MapNotice } from '@/components/Overlays';
import ReplayBar from '@/components/ReplayBar';
import Sidebar from '@/components/Sidebar';
import Toolbar, { Notices } from '@/components/StatusBar';
import { usePoller } from '@/hooks/usePoller';
import { useTraffic } from '@/store/traffic';

// Leaflet touches `window` on import, so the map is client-only.
const MapView = dynamic(() => import('@/components/MapView'), { ssr: false });

export default function Home() {
  useEffect(() => {
    // Start with the sidebar closed on phones so the map is visible.
    if (window.matchMedia('(max-width: 760px)').matches) useTraffic.getState().setSidebarOpen(false);
    void useTraffic.getState().hydrate();
  }, []);
  usePoller();
  const sidebarOpen = useTraffic((s) => s.sidebarOpen);

  // Full-bleed map with floating panels on top.
  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <MapView />
      <MapNotice />
      <Toolbar />
      <Notices />
      <Sidebar />
      <Legend />
      <ReplayBar />
      <DetailPanel />
    </div>
  );
}
