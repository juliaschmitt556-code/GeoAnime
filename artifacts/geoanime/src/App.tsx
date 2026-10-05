import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  getGetGeoSessionQueryKey,
  getReverseGeocodeQueryKey,
  useCreateGeoSession,
  useGetGeoSession,
  useReverseGeocode,
  useStopGeoSession,
  useUpdateGeoSessionLocation,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Clock3,
  Compass,
  Copy,
  Crosshair,
  Gauge,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Mountain,
  Navigation,
  Radio,
  RotateCw,
  Share2,
  ShieldCheck,
  Signal,
  Smartphone,
  StopCircle,
  WifiOff,
} from 'lucide-react';
import * as L from 'leaflet';
import mascotArt from '@assets/generated_images/geoanime-navigator.png';
import { Link, Route, Switch, useLocation as useRouterLocation, useParams, Router as WouterRouter } from 'wouter';
import type { ReactNode } from 'react';
import type { GeoAddress, GeoLocation } from '@workspace/api-client-react';

const queryClient = new QueryClient();
const SAN_ANTONIO: [number, number] = [29.4241, -98.4936];

type GpsStatus = 'idle' | 'acquiring' | 'ready' | 'denied' | 'unsupported' | 'error';
type ShareKind = 'location' | 'live';
type Fix = GeoLocation;

function fromPosition(position: GeolocationPosition, address: GeoAddress | null = null): Fix {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    altitude: position.coords.altitude,
    speed: position.coords.speed,
    heading: position.coords.heading,
    timestamp: new Date(position.timestamp).toISOString(),
    address,
  };
}

function getFix(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(fromPosition(position)),
      (error) => reject(new Error(error.code === error.PERMISSION_DENIED ? 'denied' : error.code === error.TIMEOUT ? 'timeout' : 'unavailable')),
      { enableHighAccuracy: true, timeout: 18000, maximumAge: 0 },
    );
  });
}

function isUsAddress(address?: GeoAddress | null) {
  if (!address) return false;
  const code = address.countryCode?.toUpperCase();
  const country = address.country?.trim().toLowerCase();
  return code === 'US' || code === 'USA' || country === 'united states' || country === 'united states of america';
}

function formatCoordinates(fix?: Fix | null) {
  if (!fix) return 'Awaiting location fix';
  return `${fix.latitude.toFixed(5)}°, ${fix.longitude.toFixed(5)}°`;
}

function formatAddress(address?: GeoAddress | null) {
  if (!address || !isUsAddress(address)) return '';
  return address.formatted || [address.houseNumber, address.street || address.avenue, address.city, address.state].filter(Boolean).join(', ');
}

function expiryText(date?: string | null) {
  if (!date) return 'No expiry';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return 'Expiry unavailable';
  return `Until ${parsed.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

function sessionEnded(session: { isActive: boolean; expiresAt?: string | null }) {
  return !session.isActive || (!!session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now());
}

function Brand() {
  return (
    <Link className="brand" href="/" aria-label="GeoAnime home" data-testid="link-home">
      <span className="brand-mark"><Crosshair size={19} strokeWidth={2.2} /></span>
      <span className="brand-word">geo<span>anime</span></span>
    </Link>
  );
}

function Header({ status, onInstall }: { status?: GpsStatus; onInstall?: () => void }) {
  const [canInstall, setCanInstall] = useState(false);
  useEffect(() => {
    const check = () => setCanInstall(!!(window as Window & { __pwaPrompt?: unknown }).__pwaPrompt);
    window.addEventListener('geoanime-install-ready', check);
    check();
    return () => window.removeEventListener('geoanime-install-ready', check);
  }, []);
  return (
    <header className="topbar">
      <Brand />
      <div className="top-meta">
        {status && <div className="gps-pill" data-testid="status-gps"><i className={`gps-dot ${status === 'ready' ? 'ready' : status === 'acquiring' ? 'wait' : ''}`} />GPS&nbsp; {status === 'ready' ? 'Locked' : status === 'acquiring' ? 'Seeking' : status === 'denied' ? 'Blocked' : status === 'unsupported' ? 'Unavailable' : status === 'error' ? 'No signal' : 'Standby'}</div>}
        <div className="privacy-pill"><ShieldCheck size={14} /><span>Private by design</span></div>
        {canInstall && onInstall && <button className="map-tool" onClick={onInstall} aria-label="Install GeoAnime" data-testid="button-install"><Smartphone size={16} /></button>}
      </div>
    </header>
  );
}

function MapPanel({ location, label, onRecenter, emptyTitle, emptyDescription }: { location?: Fix | null; label?: string; onRecenter?: () => void; emptyTitle?: string; emptyDescription?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const markerIcon = useMemo(() => L.divIcon({ className: 'geoanime-div-icon', html: '<div class="map-pin"></div>', iconSize: [28, 28], iconAnchor: [14, 26] }), []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: true }).setView(SAN_ANTONIO, 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    mapRef.current = map;
    const resize = () => map.invalidateSize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!location || !mapRef.current) return;
    const point: L.LatLngExpression = [location.latitude, location.longitude];
    mapRef.current.setView(point, 16, { animate: true, duration: .7 });
    if (markerRef.current) markerRef.current.setLatLng(point);
    else markerRef.current = L.marker(point, { icon: markerIcon, keyboard: false }).addTo(mapRef.current);
  }, [location?.latitude, location?.longitude, markerIcon]);

  const recenter = () => {
    if (location && mapRef.current) mapRef.current.setView([location.latitude, location.longitude], 16, { animate: true, duration: .6 });
    onRecenter?.();
  };
  return (
    <section className="map-wrap" aria-label="Location map">
      <div ref={containerRef} className="map-canvas" data-testid="map-canvas" />
      {!location && <div className="map-empty">
        <div className="map-empty-content">
          <div className="radar"><span className="radar-ring" /><Navigation size={34} strokeWidth={1.4} /></div>
          <h2>{emptyTitle || 'Every route starts here.'}</h2>
          <p>{emptyDescription || 'The map is centered on San Antonio while waiting. Your location stays off-map until you choose to request a GPS fix.'}</p>
        </div>
      </div>}
      <div className="map-vignette" />
      <div className="map-topline">
        <div className="map-chip"><MapPin size={14} color="#54e4df" /><div>{location ? label || 'Current position' : 'MAP PREVIEW'}<small>{location ? 'Position synced to map' : 'San Antonio · Texas'}</small></div></div>
        <div className="map-chip"><Signal size={13} color={location ? '#5de0ae' : '#93a5b0'} /><span>{location ? 'GPS POSITION' : 'READY FOR GPS'}</span></div>
      </div>
      <div className="map-tools">
        <button className="map-tool" onClick={recenter} aria-label="Recenter map" data-testid="button-recenter"><LocateFixedIcon /></button>
        <button className="map-tool" onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in" data-testid="button-zoom-in"><span aria-hidden="true">+</span></button>
        <button className="map-tool" onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out" data-testid="button-zoom-out"><span aria-hidden="true">−</span></button>
      </div>
      <div className="map-bottom">{location ? `±${Math.round(location.accuracy)} M · ${formatCoordinates(location)}` : 'LOCATION NOT SHARED'}</div>
      {location && <div className="map-caption"><div><strong>{label || 'Your location'}</strong><span>{formatCoordinates(location)}</span></div><span>LIVE MAP · OPENSTREETMAP / CARTO</span></div>}
    </section>
  );
}

function LocateFixedIcon() {
  return <Crosshair size={17} strokeWidth={1.8} />;
}

function GpsCard({ location, status, loading, addressError, outsideUs }: {
  location?: Fix | null; status: GpsStatus; loading: boolean; addressError: boolean; outsideUs: boolean;
}) {
  const address = formatAddress(location?.address);
  return (
    <section className="card status-card" aria-label="GPS location status">
      <div className="card-heading">
        <h2>Position readout</h2>
        <div className="status-label"><i className={`gps-dot ${status === 'ready' ? 'ready' : status === 'acquiring' ? 'wait' : ''}`} />{status === 'ready' ? 'GPS FIX' : status === 'acquiring' ? 'ACQUIRING' : 'NO FIX'}</div>
      </div>
      {location ? <>
        <div className="address" data-testid="text-address">{loading && !address ? 'Resolving U.S. address…' : address || (outsideUs ? 'Outside U.S. address coverage' : addressError ? 'Address could not be resolved' : 'Address unavailable')}</div>
        <div className="sub-address" data-testid="text-coordinates">{formatCoordinates(location)} &nbsp;·&nbsp; ±{Math.round(location.accuracy)} m</div>
        <div className="coordinates">
          <div><div className="coord-label">Latitude</div><div className="coord-value">{location.latitude.toFixed(6)}</div></div>
          <div><div className="coord-label">Longitude</div><div className="coord-value">{location.longitude.toFixed(6)}</div></div>
        </div>
        <div className="measure-row">
          {location.altitude != null && <div className="measure"><Mountain size={13} /><span>ALT&nbsp; <b>{Math.round(location.altitude)} m</b></span></div>}
          {location.speed != null && <div className="measure"><Gauge size={13} /><span>SPEED&nbsp; <b>{Math.max(0, location.speed * 3.6).toFixed(1)} km/h</b></span></div>}
          {location.heading != null && <div className="measure"><Compass size={13} /><span>HEADING&nbsp; <b>{Math.round(location.heading)}°</b></span></div>}
          {location.altitude == null && location.speed == null && location.heading == null && <div className="measure"><Clock3 size={13} /><span>FIX&nbsp; <b>{new Date(location.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></span></div>}
        </div>
        {outsideUs && <div className="route-warning" data-testid="status-outside-us"><AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />Address details are available for U.S. locations only. Coordinates are still shown.</div>}
      </> : <div className="address" data-testid="text-address">{loading ? 'Acquiring satellite fix…' : 'No location captured'}</div>}
    </section>
  );
}

function PrivacyNote() {
  return <div className="privacy-note"><LockKeyhole size={14} /><span>GPS starts only when you ask. Address lookup and map tiles use GeoAnime and OpenStreetMap/CARTO. No account, no location history.</span></div>;
}

function Footer() {
  return <footer className="app-footer"><span>GEOANIME / PRIVATE NAVIGATION</span><span>U.S. ADDRESS COVERAGE</span></footer>;
}

function usePwa() {
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const eventHandler = (event: Event) => {
      event.preventDefault();
      deferredRef.current = event as BeforeInstallPromptEvent;
      (window as Window & { __pwaPrompt?: boolean }).__pwaPrompt = true;
      window.dispatchEvent(new Event('geoanime-install-ready'));
    };
    const online = () => setOffline(false);
    const offlineEvent = () => setOffline(true);
    window.addEventListener('beforeinstallprompt', eventHandler);
    window.addEventListener('online', online);
    window.addEventListener('offline', offlineEvent);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`).catch(() => undefined);
    return () => {
      window.removeEventListener('beforeinstallprompt', eventHandler);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offlineEvent);
    };
  }, []);
  const install = async () => {
    const prompt = deferredRef.current;
    if (!prompt) return;
    await prompt.prompt();
    deferredRef.current = null;
    (window as Window & { __pwaPrompt?: boolean }).__pwaPrompt = false;
    window.dispatchEvent(new Event('geoanime-install-ready'));
  };
  return { offline, install };
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function Home() {
  const [fix, setFix] = useState<Fix | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle');
  const [gpsMessage, setGpsMessage] = useState('');
  const [shareKind, setShareKind] = useState<ShareKind>('location');
  const [expiresMinutes, setExpiresMinutes] = useState(60);
  const [shareResult, setShareResult] = useState<{ url: string; kind: ShareKind } | null>(null);
  const [toast, setToast] = useState('');
  const [liveSession, setLiveSession] = useState<{ id: string; ownerToken: string; location: Fix } | null>(null);
  const [isLiveRunning, setIsLiveRunning] = useState(false);
  const watchIdRef = useRef<number | null>(null);
  const createSession = useCreateGeoSession();
  const ownerRequest = liveSession?.ownerToken ? { headers: { 'x-owner-token': liveSession.ownerToken } } : undefined;
  const updateLocation = useUpdateGeoSessionLocation({ request: ownerRequest });
  const stopSession = useStopGeoSession({ request: ownerRequest });
  const { offline, install } = usePwa();

  const validCoords = !!fix && fix.latitude >= -90 && fix.latitude <= 90 && fix.longitude >= -180 && fix.longitude <= 180;
  const params = { lat: validCoords ? fix!.latitude : 0, lon: validCoords ? fix!.longitude : 0 };
  const reverseQuery = useReverseGeocode(params, {
    query: { enabled: validCoords && !offline, queryKey: getReverseGeocodeQueryKey(params), retry: 1, staleTime: 60_000 },
  });
  const usAddress = reverseQuery.data && isUsAddress(reverseQuery.data) ? reverseQuery.data : null;
  const outsideUs = !!reverseQuery.data && !isUsAddress(reverseQuery.data);
  const resolvedFix = fix ? { ...fix, address: usAddress || (isUsAddress(fix.address) ? fix.address : null) } : null;

  const requestFix = useCallback(async () => {
    setGpsStatus('acquiring');
    setGpsMessage('');
    try {
      const next = await getFix();
      setFix(next);
      setGpsStatus('ready');
      return next;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unavailable';
      if (reason === 'denied') {
        setGpsStatus('denied');
        setGpsMessage('Location permission is blocked. Allow location access in your browser settings, then try again.');
      } else if (reason === 'unsupported') {
        setGpsStatus('unsupported');
        setGpsMessage('This browser does not provide GPS location services.');
      } else {
        setGpsStatus('error');
        setGpsMessage(reason === 'timeout' ? 'GPS did not respond in time. Move to a clearer area and retry.' : 'Could not get a GPS fix. Check device location services and retry.');
      }
      return null;
    }
  }, []);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const shareUrl = async (url: string, title: string) => {
    const absolute = new URL(url, window.location.origin).toString();
    if (navigator.share) {
      try {
        await navigator.share({ title, text: 'A private location shared with GeoAnime', url: absolute });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(absolute);
      showToast('Share link copied to clipboard.');
    } catch {
      showToast('Could not access clipboard. Copy the visible share link instead.');
    }
  };

  const createShare = async () => {
    const point = resolvedFix || await requestFix();
    if (!point) return;
    if (offline) {
      showToast('You are offline. A share cannot be created until you reconnect.');
      return;
    }
    try {
      const created = await createSession.mutateAsync({
        data: {
          kind: shareKind,
          expiresMinutes: expiresMinutes as 0 | 15 | 60 | 480,
          location: { ...point, address: isUsAddress(point.address) ? point.address : null },
        },
      });
      const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
      const url = `${window.location.origin}${basePath}/${shareKind === 'live' ? 'live' : 'location'}/${created.session.id}`;
      setShareResult({ url, kind: shareKind });
      if (shareKind === 'live') {
        setLiveSession({ id: created.session.id, ownerToken: created.ownerToken, location: point });
        setIsLiveRunning(true);
      }
      await shareUrl(url, shareKind === 'live' ? 'GeoAnime live location' : 'GeoAnime location');
    } catch {
      showToast('Share could not be created. Check your connection and try again.');
    }
  };

  const stopLive = async () => {
    if (!liveSession) return;
    try {
      await stopSession.mutateAsync({ id: liveSession.id });
      setIsLiveRunning(false);
      if (watchIdRef.current != null && navigator.geolocation) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      setLiveSession(null);
      showToast('Live location stopped.');
    } catch {
      showToast('The live share could not be stopped. Please retry while online.');
    }
  };

  useEffect(() => {
    if (!isLiveRunning || !liveSession || !navigator.geolocation || offline) return;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const next = fromPosition(position);
        setLiveSession((previous) => previous ? { ...previous, location: next } : previous);
        setFix(next);
        updateLocation.mutate({ id: liveSession.id, data: { location: next } });
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setIsLiveRunning(false);
          setGpsStatus('denied');
          setGpsMessage('Location access was revoked. The live share is no longer receiving updates.');
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    };
  }, [isLiveRunning, liveSession?.id, offline]);

  useEffect(() => {
    if (!liveSession) return;
    const address = usAddress;
    if (address && address !== liveSession.location.address) {
      setLiveSession((current) => current ? { ...current, location: { ...current.location, address } } : current);
    }
  }, [usAddress, liveSession?.id]);

  return (
    <div className="app-shell">
      <div className="layout">
        <Header status={gpsStatus} onInstall={install} />
        <div className="main-grid">
          <section className="control-column">
            <div className="hero-copy">
              <div className="eyebrow">Your companion, on the way</div>
              <h1>Know where you are.<br /><em>Feel the way there.</em></h1>
              <p>A precise GPS fix, with a quiet companion at your side. Your location is yours until you decide to share.</p>
            </div>
            <aside className="companion-card" data-testid="card-companion">
              <img src={mascotArt} alt="Aster, GeoAnime's navigator companion" />
              <div className="companion-card-shade" />
              <div className="companion-copy"><span>ROUTE COMPANION / ASTER</span><strong>I'll keep the signal.</strong><small>Nothing moves until you say so.</small></div>
              <div className="companion-badge"><Crosshair size={15} /></div>
            </aside>
            {offline && <div className="offline-banner" data-testid="status-offline"><WifiOff size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />Offline — maps may be cached, but address lookup and sharing need a connection.</div>}
            <GpsCard location={resolvedFix} status={gpsStatus} loading={gpsStatus === 'acquiring' || reverseQuery.isFetching} addressError={!!reverseQuery.error} outsideUs={outsideUs} />
            <section className="card action-block">
              <div className="card-heading"><h2>Choose your signal</h2><Radio size={15} color="#54e4df" /></div>
              <p className="action-description">Create a private link, only when you choose. A live share updates while you keep it running.</p>
              <div className="switch-line"><span>Share type</span><div className="segmented" role="group" aria-label="Share type">
                <button className={`segment ${shareKind === 'location' ? 'active' : ''}`} onClick={() => { setShareKind('location'); setShareResult(null); }} data-testid="button-share-fixed">One-time</button>
                <button className={`segment ${shareKind === 'live' ? 'active' : ''}`} onClick={() => { setShareKind('live'); setShareResult(null); }} data-testid="button-share-live">Live</button>
              </div></div>
              <div className="switch-line"><span>Link duration</span><label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <select value={expiresMinutes} onChange={(event) => setExpiresMinutes(Number(event.target.value))} aria-label="Link duration" data-testid="select-expiry">
                  <option value={15}>15 minutes</option><option value={60}>1 hour</option><option value={480}>8 hours</option><option value={0}>No expiry</option>
                </select><ChevronDown size={12} />
              </label></div>
              {shareResult && <div className="share-link" data-testid="text-share-link"><span>{shareResult.url}</span><button className="map-tool" style={{ width: 28, height: 28, borderRadius: 7 }} onClick={() => shareUrl(shareResult.url, 'GeoAnime location')} aria-label="Copy share link" data-testid="button-copy-share"><Copy size={13} /></button></div>}
              <div className="button-row" style={{ marginTop: 15 }}>
                {liveSession ? <button className="btn btn-stop" onClick={stopLive} disabled={stopSession.isPending} data-testid="button-stop-live"><StopCircle size={15} />{stopSession.isPending ? 'Stopping…' : 'Stop live'}</button> :
                  <button className="btn btn-primary" onClick={createShare} disabled={createSession.isPending || offline} data-testid="button-create-share">{createSession.isPending ? <LoaderCircle size={15} className="spin" /> : shareKind === 'live' ? <Radio size={15} /> : <Share2 size={15} />}{createSession.isPending ? 'Creating link…' : shareKind === 'live' ? 'Start live share' : 'Share this fix'}</button>}
                <button className="btn btn-secondary" onClick={() => void requestFix()} disabled={gpsStatus === 'acquiring'} data-testid="button-get-location">{gpsStatus === 'acquiring' ? <LoaderCircle size={15} className="spin" /> : <LocateFixedIcon />}{gpsStatus === 'acquiring' ? 'Locating…' : 'Get GPS fix'}</button>
              </div>
              {gpsMessage && <div className="route-warning" role="alert" data-testid="status-gps-error"><AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />{gpsMessage} <button onClick={() => void requestFix()} style={{ color: '#f1cead', background: 'transparent', border: 0, textDecoration: 'underline', cursor: 'pointer', marginLeft: 4 }} data-testid="button-retry-gps">Retry</button></div>}
              {liveSession && <div className="share-link" data-testid="status-live-active"><span><i className={`gps-dot ${isLiveRunning ? 'ready' : ''}`} style={{ display: 'inline-block', marginRight: 7 }} />{isLiveRunning ? 'Live location is sharing' : 'Live share updates paused'}</span><span>{updateLocation.isPending ? 'syncing' : isLiveRunning ? 'running' : 'paused'}</span></div>}
            </section>
            {toast && <div className="toast-inline" role="status" data-testid="status-toast">{toast}</div>}
            <PrivacyNote />
            <Footer />
          </section>
          <MapPanel location={resolvedFix} onRecenter={() => { if (!fix) void requestFix(); }} />
        </div>
      </div>
    </div>
  );
}

function PublicShare() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id || '';
  const [routerLocation] = useRouterLocation();
  const [shareNotice, setShareNotice] = useState('');
  const isLive = routerLocation.startsWith('/live/');
  const { offline, install } = usePwa();
  const queryKey = getGetGeoSessionQueryKey(sessionId);
  const [, setExpiryTick] = useState(0);
  const query = useGetGeoSession(sessionId, {
    query: {
      enabled: !!sessionId,
      queryKey,
      refetchInterval: (state) => {
        const session = state.state.data;
        return isLive && session?.isActive && (!session.expiresAt || new Date(session.expiresAt).getTime() > Date.now()) ? 5000 : false;
      },
      refetchIntervalInBackground: true,
    },
  });
  const session = query.data;
  const location = session?.location;
  const coordinates = location ? { lat: location.latitude, lon: location.longitude } : null;
  const reverseParams = coordinates || { lat: 0, lon: 0 };
  const reverse = useReverseGeocode(reverseParams, {
    query: {
      enabled: !!coordinates && !offline && !isUsAddress(location?.address),
      queryKey: getReverseGeocodeQueryKey(reverseParams),
      retry: 1,
      staleTime: 60_000,
    },
  });
  const address = location?.address && isUsAddress(location.address) ? location.address : reverse.data && isUsAddress(reverse.data) ? reverse.data : null;
  const publicFix = location ? { ...location, address } : null;
  const expired = session ? (!!session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) : false;
  const stopped = session ? !session.isActive && !expired : false;
  const ended = expired || stopped;

  useEffect(() => {
    if (!session?.expiresAt) return;
    const delay = new Date(session.expiresAt).getTime() - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setExpiryTick((tick) => tick + 1), Math.min(delay + 80, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [session?.expiresAt, session?.updatedAt]);

  const shareCurrent = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try { await navigator.share({ title: 'GeoAnime location', url }); return; }
      catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareNotice('Link copied to clipboard.');
    } catch {
      setShareNotice('Clipboard is unavailable. Copy this page address from your browser.');
    }
  };

  if (session && !location) {
    return (
      <div className="app-shell">
        <div className="layout">
          <Header onInstall={install} />
          <div className="share-page">
            <section className="share-aside">
              <div className="eyebrow">SHARED POSITION</div>
              <div className="card action-block" data-testid="status-waiting-location">
                <LoaderCircle size={22} className="spin" color="#54e4df" />
                <h1 className="action-title" style={{ fontSize: 22, marginTop: 13 }}>Waiting for location…</h1>
                <p className="action-description">This shared session is ready, but the first GPS position has not arrived yet.</p>
              </div>
              <PrivacyNote />
              <Footer />
            </section>
            <MapPanel emptyTitle="Waiting for location…" emptyDescription="The map will update when the first position is available." />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="layout">
        <Header onInstall={install} />
        {query.isLoading ? <div className="share-page"><div className="share-aside"><div className="skeleton" style={{ height: 22, width: 180 }} /><div className="skeleton" style={{ height: 150 }} /><div className="skeleton" style={{ height: 196 }} /></div><div className="skeleton" style={{ minHeight: 480 }} /></div> :
          query.error ? <div className="share-page"><section className="share-aside"><div className="eyebrow">SHARED POSITION</div><div className="card action-block"><AlertTriangle size={22} color="#f1a3b5" /><h1 className="action-title" style={{ fontSize: 22, marginTop: 13 }}>This link is unavailable.</h1><p className="action-description">It may have expired, been removed, or the connection may be unavailable.</p><button className="btn btn-secondary" onClick={() => void query.refetch()} data-testid="button-retry-session"><RotateCw size={14} />Try again</button></div></section><MapPanel /></div> :
            session && location && <div className="share-page">
              <section className="share-aside">
                <div className="eyebrow">{isLive ? 'LIVE COMPANION LINK' : 'SHARED POSITION'}</div>
                <div className="share-visual">
                  <img src={mascotArt} alt="Aster, GeoAnime's navigator companion" />
                  <div className="share-visual-copy"><strong>With you, wherever.</strong><span>ASTER / YOUR ROUTE COMPANION</span></div>
                </div>
                {offline && <div className="offline-banner" data-testid="status-offline"><WifiOff size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />Offline — the last synced position may be out of date.</div>}
                {ended ? <div className="card action-block" data-testid="status-share-ended">
                  <div className="status-label" style={{ color: expired ? '#f0c990' : '#f1a3b5' }}><i className="gps-dot" />{expired ? 'LINK EXPIRED' : 'SHARING STOPPED'}</div>
                  <h1 className="action-title" style={{ fontSize: 23, marginTop: 12 }}>{expired ? 'This route has ended.' : 'This signal went quiet.'}</h1>
                  <p className="action-description">{expired ? 'The location owner set an expiry for this private link.' : 'The owner stopped sharing this location. No further updates will arrive.'}</p>
                </div> : <>
                  <div className="card status-card">
                    <div className="card-heading"><h2>{isLive ? 'Live position' : 'Pinned position'}</h2><div className="status-label"><i className={`gps-dot ${session.isActive ? 'ready' : ''}`} />{isLive ? 'LIVE' : 'FIXED'}</div></div>
                    <div className="address" data-testid="text-shared-address">{formatAddress(address) || (reverse.isFetching ? 'Resolving U.S. address…' : 'U.S. address unavailable')}</div>
                    <div className="sub-address" data-testid="text-shared-coordinates">{formatCoordinates(publicFix)} &nbsp;·&nbsp; ±{Math.round(location.accuracy)} m</div>
                    <div className="coordinates"><div><div className="coord-label">Latitude</div><div className="coord-value">{location.latitude.toFixed(6)}</div></div><div><div className="coord-label">Longitude</div><div className="coord-value">{location.longitude.toFixed(6)}</div></div></div>
                    <div className="measure-row">
                      {location.altitude != null && <div className="measure"><Mountain size={13} /><span>ALT&nbsp; <b>{Math.round(location.altitude)} m</b></span></div>}
                      {location.speed != null && <div className="measure"><Gauge size={13} /><span>SPEED&nbsp; <b>{(location.speed * 3.6).toFixed(1)} km/h</b></span></div>}
                      {location.heading != null && <div className="measure"><Compass size={13} /><span>HEADING&nbsp; <b>{Math.round(location.heading)}°</b></span></div>}
                    </div>
                    {address && <div className="sub-address" style={{ marginTop: 14 }}>{[address.neighborhood, address.postalCode].filter(Boolean).join(' · ')}</div>}
                  </div>
                  <div className="card action-block">
                    <div className="card-heading"><h2>Share details</h2><Share2 size={14} color="#54e4df" /></div>
                    <p className="action-description">{isLive ? 'This page refreshes while the owner’s live signal is active.' : 'A private, fixed position shared from GeoAnime.'}</p>
                    <div className="share-link"><span>{expiryText(session.expiresAt)}</span><Clock3 size={13} /></div>
                    <button className="btn btn-primary" style={{ width: '100%', marginTop: 13 }} onClick={shareCurrent} data-testid="button-share-page"><Link2 size={14} />Share this page <ArrowUpRight size={13} /></button>
                    {shareNotice && <div className="toast-inline" style={{ marginTop: 10 }} role="status" data-testid="status-share-notice">{shareNotice}</div>}
                  </div>
                </>}
                <PrivacyNote />
                <Footer />
              </section>
              <MapPanel
                location={ended ? null : publicFix}
                label={isLive ? 'Live shared position' : 'Shared position'}
                emptyTitle={ended ? 'This signal went quiet.' : undefined}
                emptyDescription={ended ? 'This share is no longer active. Ask the owner for a fresh GeoAnime link.' : undefined}
              />
            </div>}
      </div>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/location/:id" component={PublicShare} />
        <Route path="/live/:id" component={PublicShare} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function NotFound() {
  const [, setLocation] = useRouterLocation();
  const { install } = usePwa();
  return <div className="app-shell"><div className="layout"><Header onInstall={install} /><main className="card action-block" style={{ maxWidth: 500, margin: '10vh auto' }}><div className="eyebrow">OFF COURSE</div><h1 className="action-title" style={{ fontSize: 32, marginTop: 18 }}>This path isn't mapped.</h1><p className="action-description">That GeoAnime link may be incomplete or no longer available.</p><button className="btn btn-primary" onClick={() => setLocation('/')} data-testid="button-home"><Navigation size={15} />Return to map</button></main></div></div>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useRouterLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
