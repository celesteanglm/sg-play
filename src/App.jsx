import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import {
  ArrowLeft,
  ChevronsUp,
  CircleDot,
  ExternalLink,
  Filter,
  Info,
  LocateFixed,
  MapPin,
  Navigation,
  Ruler,
  Search,
  Trees,
  X,
} from "lucide-react";
import { trackPageView } from "./lib/analytics.js";

const SINGAPORE_CENTER = [1.3521, 103.8198];
const DEFAULT_ZOOM = 12;
const MOBILE_SHEET_QUERY = "(max-width: 860px)";
const SHEET_DRAG_THRESHOLD_PX = 44;
const RESULT_PAGE_SIZE = 16;
const PLAYGROUND_REFRESH_MS = 60 * 60 * 1000;
const REGION_FILTERS = ["Central", "North", "South", "East", "West"];
const TYPE_FILTERS = [
  {
    value: "Dedicated playground",
    label: "Dedicated playground",
    definition: "A specific NParks playground record whose name contains PG or PLAYGROUND.",
  },
  {
    value: "Park with playground",
    label: "Park with playground",
    definition: "A Parks@SG park record that lists Playground as one of its amenities.",
  },
];
const AREA_CATEGORY_DEFINITIONS = [
  {
    value: "Pocket",
    label: "Pocket",
    definition: "Managed-area size under 2,000 sqm.",
  },
  {
    value: "Neighbourhood",
    label: "Neighbourhood",
    definition: "Managed-area size from 2,000 sqm to under 10,000 sqm.",
  },
  {
    value: "Large",
    label: "Large",
    definition: "Managed-area size from 10,000 sqm to under 50,000 sqm.",
  },
  {
    value: "Destination",
    label: "Destination",
    definition: "Managed-area size of 50,000 sqm or more.",
  },
  {
    value: "Area unavailable",
    label: "Area unavailable",
    definition: "No official managed-area polygon size was available for the record.",
  },
];
const SIZE_FILTERS = AREA_CATEGORY_DEFINITIONS.filter((category) => category.value !== "Area unavailable");

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    function handlePopState() {
      setPath(window.location.pathname);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function navigate(nextPath) {
    if (window.location.pathname === nextPath) return;

    window.history.pushState(null, "", nextPath);
    setPath(nextPath);
  }

  useEffect(() => {
    trackPageView(path);
  }, [path]);

  if (path === "/data") return <DataInfoPage onNavigate={navigate} />;

  return <PlaygroundMapPage onNavigate={navigate} />;
}

function PlaygroundMapPage({ onNavigate }) {
  const [dataset, setDataset] = useState(null);
  const [loadingError, setLoadingError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(createDefaultFilters);
  const [userLocation, setUserLocation] = useState(null);
  const [userLocationAccuracy, setUserLocationAccuracy] = useState(null);
  const [isLocating, setIsLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState("");
  const [mapCenter, setMapCenter] = useState(SINGAPORE_CENTER);
  const [visibleResultCount, setVisibleResultCount] = useState(RESULT_PAGE_SIZE);
  const [sheetMode, setSheetMode] = useState(getInitialSheetMode);
  const [sheetHasUserInteracted, setSheetHasUserInteracted] = useState(false);
  const mapRef = useRef(null);
  const sheetDragStartY = useRef(null);
  const sheetDidDrag = useRef(false);

  useEffect(() => {
    let mounted = true;
    let refreshTimer = null;

    async function loadPlaygrounds({ cacheBust = false } = {}) {
      try {
        const url = cacheBust ? `/data/playgrounds.json?refresh=${Date.now()}` : "/data/playgrounds.json";
        const response = await fetch(url, { cache: cacheBust ? "no-store" : "default" });
        if (!response.ok) throw new Error(`Playground data returned ${response.status}`);
        const payload = await response.json();
        if (!mounted) return;

        setDataset(payload);
        setLoadingError("");
        setSelectedId((current) =>
          current && payload.playgrounds?.some((playground) => playground.id === current)
            ? current
            : payload.playgrounds?.[0]?.id || null,
        );
      } catch (error) {
        if (!mounted) return;
        setLoadingError(error instanceof Error ? error.message : "Unable to load playground data.");
      }
    }

    loadPlaygrounds();
    refreshTimer = window.setInterval(() => {
      loadPlaygrounds({ cacheBust: true });
    }, PLAYGROUND_REFRESH_MS);

    return () => {
      mounted = false;
      if (refreshTimer) window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_SHEET_QUERY);

    function syncMobileDefaultSheet() {
      if (mediaQuery.matches && !sheetHasUserInteracted) {
        setSheetMode("collapsed");
      } else if (!mediaQuery.matches) {
        setSheetMode("expanded");
      }
    }

    syncMobileDefaultSheet();
    mediaQuery.addEventListener("change", syncMobileDefaultSheet);

    return () => mediaQuery.removeEventListener("change", syncMobileDefaultSheet);
  }, [sheetHasUserInteracted]);

  const playgrounds = dataset?.playgrounds || [];
  const searchTokens = useMemo(() => normalizeText(query).split(" ").filter(Boolean), [query]);
  const filteredPlaygrounds = useMemo(
    () => playgrounds.filter((playground) => playgroundPassesFilters(playground, filters, searchTokens)),
    [filters, playgrounds, searchTokens],
  );
  const rankingOrigin = userLocation || mapCenter;
  const rankedPlaygrounds = useMemo(
    () => rankPlaygroundsByDistance(rankingOrigin, filteredPlaygrounds, searchTokens),
    [filteredPlaygrounds, rankingOrigin, searchTokens],
  );
  const visiblePlaygrounds = rankedPlaygrounds.slice(0, visibleResultCount);
  const selectedPlayground =
    filteredPlaygrounds.find((playground) => playground.id === selectedId) || rankedPlaygrounds[0]?.playground || null;
  const selectedDistance = selectedPlayground
    ? getDistanceMeters(rankingOrigin, [selectedPlayground.latitude, selectedPlayground.longitude])
    : null;
  const stats = useMemo(() => buildStats(filteredPlaygrounds), [filteredPlaygrounds]);
  const activeFilterCount = getActiveFilterCount(filters);
  const hasMoreResults = visiblePlaygrounds.length < rankedPlaygrounds.length;

  useEffect(() => {
    setVisibleResultCount(RESULT_PAGE_SIZE);
  }, [filters, query, rankingOrigin]);

  useEffect(() => {
    if (filteredPlaygrounds.length === 0) {
      setSelectedId(null);
      return;
    }

    setSelectedId((current) =>
      current && filteredPlaygrounds.some((playground) => playground.id === current)
        ? current
        : rankedPlaygrounds[0]?.playground.id || null,
    );
  }, [filteredPlaygrounds, rankedPlaygrounds]);

  const handleMapCenterChange = useCallback((nextCenter) => {
    setMapCenter((current) => (isSameMapCenter(current, nextCenter) ? current : nextCenter));
  }, []);

  function selectPlayground(playground) {
    setSelectedId(playground.id);
    setSheetHasUserInteracted(true);
    setSheetMode("expanded");
    mapRef.current?.flyTo([playground.latitude, playground.longitude], Math.max(mapRef.current.getZoom(), 15), {
      duration: 0.35,
    });
  }

  function handleLocateMe() {
    if (isLocating) return;

    if (!navigator.geolocation) {
      setLocationNotice("Location is not available in this browser.");
      return;
    }

    setIsLocating(true);
    setLocationNotice("Finding playgrounds near you...");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextLocation = [position.coords.latitude, position.coords.longitude];
        const nearest = rankPlaygroundsByDistance(nextLocation, filteredPlaygrounds)[0]?.playground;

        setUserLocation(nextLocation);
        setUserLocationAccuracy(position.coords.accuracy);
        setIsLocating(false);

        if (!nearest) {
          setLocationNotice("No playgrounds match the current filters near your location.");
          mapRef.current?.flyTo(nextLocation, 15, { duration: 0.45 });
          return;
        }

        setSelectedId(nearest.id);
        setVisibleResultCount(RESULT_PAGE_SIZE);
        setSheetHasUserInteracted(true);
        setSheetMode("expanded");
        setLocationNotice(
          `Selected the nearest visible playground. Accuracy ${formatAccuracyMeters(position.coords.accuracy)}.`,
        );
        zoomToLocationAndPlayground(mapRef.current, nextLocation, nearest);
      },
      (error) => {
        setIsLocating(false);
        setLocationNotice(getLocationErrorMessage(error));
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    );
  }

  function toggleArrayFilter(key, value) {
    setFilters((current) => ({
      ...current,
      [key]: toggleValue(current[key], value),
    }));
  }

  function toggleTypeFilter(type) {
    toggleArrayFilter("types", type);
  }

  function clearFilters() {
    setFilters(createDefaultFilters());
    setQuery("");
  }

  function handleSheetPointerDown(event) {
    if (event.button != null && event.button !== 0) return;

    sheetDragStartY.current = event.clientY;
    event.currentTarget.setPointerCapture?.(event.pointerId);

    window.addEventListener(
      "pointerup",
      (pointerEvent) => {
        if (pointerEvent.pointerId === event.pointerId) finishSheetDrag(pointerEvent.clientY);
      },
      { once: true },
    );
  }

  function handleSheetPointerUp(event) {
    if (sheetDragStartY.current == null) return;

    finishSheetDrag(event.clientY);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleSheetPointerCancel(event) {
    sheetDragStartY.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleSheetMouseDown(event) {
    if (sheetDragStartY.current != null || event.button !== 0) return;

    sheetDragStartY.current = event.clientY;
    window.addEventListener("mouseup", (mouseEvent) => finishSheetDrag(mouseEvent.clientY), { once: true });
  }

  function finishSheetDrag(endY) {
    if (sheetDragStartY.current == null) return;

    const deltaY = endY - sheetDragStartY.current;
    sheetDragStartY.current = null;
    sheetDidDrag.current = Math.abs(deltaY) > SHEET_DRAG_THRESHOLD_PX;

    if (sheetDidDrag.current) {
      window.setTimeout(() => {
        sheetDidDrag.current = false;
      }, 400);
    }

    if (deltaY > SHEET_DRAG_THRESHOLD_PX) {
      setSheetHasUserInteracted(true);
      setSheetMode("collapsed");
    } else if (deltaY < -SHEET_DRAG_THRESHOLD_PX) {
      setSheetHasUserInteracted(true);
      setSheetMode("expanded");
    }
  }

  function toggleSheetMode() {
    if (sheetDidDrag.current) {
      sheetDidDrag.current = false;
      return;
    }

    setSheetHasUserInteracted(true);
    setSheetMode((current) => (current === "expanded" ? "collapsed" : "expanded"));
  }

  return (
    <main className="app-shell">
      <section className="map-stage" aria-label="Singapore public playground map">
        <div className="top-panel">
          <div className="brand-row">
            <div className="brand-mark" aria-hidden="true">
              <Trees size={25} />
            </div>
            <div className="brand-copy">
              <div className="brand-titleline">
                <h1>PlaySG</h1>
                <span className={dataset ? "live-pill" : "live-pill loading"}>
                  <span aria-hidden="true" />
                  {dataset ? "Public map" : "Loading"}
                </span>
              </div>
              <p className="brand-tagline">Parks, playgrounds, and tiny adventures.</p>
              <p className="brand-status">
                {dataset ? `${filteredPlaygrounds.length} visible · ${stats.destinationCount} destination parks` : "Loading playgrounds"}
              </p>
            </div>
            <div className="brand-actions">
              <button className="icon-button" type="button" onClick={() => onNavigate("/data")} aria-label="Data sources">
                <Info size={19} />
              </button>
              <button
                className={isLocating ? "icon-button location-button locating" : "icon-button location-button"}
                type="button"
                onClick={handleLocateMe}
                aria-busy={isLocating}
                aria-label="Use my location"
                title="Find playgrounds near me"
                disabled={isLocating || filteredPlaygrounds.length === 0}
              >
                <LocateFixed size={19} />
              </button>
            </div>
          </div>

          <label className="search-box">
            <Search size={18} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search playground, park, region"
              aria-label="Search playgrounds, parks, or regions"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={16} />
              </button>
            ) : null}
          </label>

          <div className="filter-scroller" aria-label="Playground filters">
            <span className="filter-rail-label">
              <Filter size={14} aria-hidden="true" />
              Filters
            </span>
            <button
              className={activeFilterCount === 0 && !query ? "chip active" : "chip"}
              type="button"
              onClick={clearFilters}
              aria-label="Clear search and filters"
            >
              <span className="chip-icon all" aria-hidden="true">
                <CircleDot size={14} />
              </span>
              <span>All</span>
              <span className="chip-count">{playgrounds.length}</span>
            </button>
            <span className="filter-divider" aria-hidden="true" />
            <FilterGroupLabel label="Category" description="What the record is" />
            {TYPE_FILTERS.map((type) => (
              <FilterChip
                active={filters.types.includes(type.value)}
                count={playgrounds.filter((playground) => playground.type === type.value).length}
                description={type.definition}
                key={type.value}
                label={type.label}
                onSelect={() => toggleTypeFilter(type.value)}
              />
            ))}
            <span className="filter-divider" aria-hidden="true" />
            <FilterGroupLabel label="Size option" description="Managed-area scale" />
            {SIZE_FILTERS.map((size) => (
              <FilterChip
                active={filters.sizes.includes(size.value)}
                count={playgrounds.filter((playground) => playground.areaCategory === size.value).length}
                description={size.definition}
                key={size.value}
                label={size.label}
                onSelect={() => toggleArrayFilter("sizes", size.value)}
              />
            ))}
            <span className="filter-divider" aria-hidden="true" />
            <FilterGroupLabel label="Region" description="Singapore area" />
            {REGION_FILTERS.map((region) => (
              <FilterChip
                active={filters.regions.includes(region)}
                count={playgrounds.filter((playground) => playground.region === region).length}
                key={region}
                label={region}
                onSelect={() => toggleArrayFilter("regions", region)}
              />
            ))}
          </div>

          {locationNotice || loadingError ? <div className="location-notice">{locationNotice || loadingError}</div> : null}
        </div>

        <MapContainer
          center={SINGAPORE_CENTER}
          zoom={DEFAULT_ZOOM}
          minZoom={10}
          maxZoom={18}
          zoomControl={false}
          scrollWheelZoom
          className="playground-map"
        >
          <MapBridge mapRef={mapRef} onCenterChange={handleMapCenterChange} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {filteredPlaygrounds.map((playground) => (
            <Marker
              key={playground.id}
              position={[playground.latitude, playground.longitude]}
              icon={createPlaygroundIcon(playground, playground.id === selectedPlayground?.id)}
              eventHandlers={{ click: () => selectPlayground(playground) }}
            >
              <Popup>
                <strong>{playground.name}</strong>
                <span>{playground.areaLabel}</span>
                <a href={playground.googleMapsUrl} target="_blank" rel="noreferrer">
                  Open coordinates
                </a>
              </Popup>
            </Marker>
          ))}
          {userLocation ? (
            <Marker position={userLocation} icon={createUserIcon()} zIndexOffset={1000}>
              <Popup>
                <strong>Your location</strong>
                {formatAccuracyMeters(userLocationAccuracy) ? <span>Accuracy {formatAccuracyMeters(userLocationAccuracy)}</span> : null}
              </Popup>
            </Marker>
          ) : null}
        </MapContainer>
      </section>

      <section className={`bottom-sheet sheet-${sheetMode}`} aria-label="Playground details and results">
        <button
          className="sheet-handle"
          type="button"
          onClick={toggleSheetMode}
          onPointerDown={handleSheetPointerDown}
          onPointerUp={handleSheetPointerUp}
          onPointerCancel={handleSheetPointerCancel}
          onMouseDown={handleSheetMouseDown}
          aria-expanded={sheetMode === "expanded"}
          aria-label={sheetMode === "expanded" ? "Collapse playground details" : "Expand playground details"}
        >
          <span className="sheet-handle-bar" aria-hidden="true" />
          {sheetMode === "collapsed" ? <ChevronsUp className="sheet-swipe-cue" size={18} aria-hidden="true" /> : null}
        </button>

        <div className="sheet-content">
          <div className="panel-kicker">
            <span>
              <Trees size={15} aria-hidden="true" />
              Family play map
            </span>
            <span>{dataset ? `Updated ${formatDate(dataset.generatedAt)}` : "Loading data"}</span>
          </div>

          <div className="summary-strip">
            <StatTile label="Dedicated" value={formatCompactCount(stats.dedicatedCount)} tone="green" />
            <StatTile label="Parks with play" value={formatCompactCount(stats.parkWithPlaygroundCount)} tone="blue" />
            <StatTile label="Pocket size" value={formatCompactCount(stats.pocketCount)} tone="dark" />
          </div>

          {selectedPlayground ? (
            <PlaygroundDetail playground={selectedPlayground} distanceMeters={selectedDistance} />
          ) : (
            <div className="empty-state">
              <CircleDot size={22} />
              <p>{loadingError || "No playgrounds match the current search and filters."}</p>
              {activeFilterCount || query ? (
                <button className="show-more-button empty-action" type="button" onClick={clearFilters}>
                  Clear filters
                </button>
              ) : null}
            </div>
          )}

          <div className="nearby-header">
            <span>Nearby options</span>
            <span>
              Showing {formatCompactCount(visiblePlaygrounds.length)} of {formatCompactCount(rankedPlaygrounds.length)}
              {userLocation ? " nearest to you" : ""}
            </span>
          </div>

          <div className="station-list">
            {visiblePlaygrounds.map(({ playground, distanceMeters }) => (
              <button
                className={playground.id === selectedPlayground?.id ? "station-row active" : "station-row"}
                key={playground.id}
                type="button"
                onClick={() => selectPlayground(playground)}
              >
                <StatusDot category={playground.areaCategory} />
                <div>
                  <strong>{playground.name}</strong>
                  <span>{playground.region} · {playground.type}</span>
                </div>
                <div className="row-meta">
                  <span className="size-badge">{playground.areaCategory}</span>
                  <span className="row-distance">{formatDistanceMeters(distanceMeters)}</span>
                  <b>{playground.areaLabel}</b>
                </div>
              </button>
            ))}
          </div>

          {hasMoreResults ? (
            <div className="station-list-footer">
              <button
                type="button"
                className="show-more-button"
                onClick={() => setVisibleResultCount((count) => count + RESULT_PAGE_SIZE)}
              >
                Show more
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function DataInfoPage({ onNavigate }) {
  const [dataset, setDataset] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function loadDataset() {
      const response = await fetch("/data/playgrounds.json");
      const payload = await response.json();
      if (mounted) setDataset(payload);
    }

    loadDataset().catch(() => {
      if (mounted) setDataset(null);
    });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <main className="info-page">
      <header className="info-header">
        <button className="back-button" type="button" onClick={() => onNavigate("/")} aria-label="Back to map">
          <ArrowLeft size={18} />
          Map
        </button>
        <div>
          <p>Data sources</p>
          <h1>Official playground data, with caveats</h1>
        </div>
      </header>

      <section className="info-status" aria-label="Current playground dataset status">
        <div>
          <span>Records</span>
          <strong>{dataset ? formatCompactCount(dataset.count) : "Loading"}</strong>
        </div>
        <div>
          <span>Generated</span>
          <strong>{dataset ? formatDate(dataset.generatedAt) : "Loading"}</strong>
        </div>
        <div>
          <span>Map links</span>
          <strong>Google Maps coordinates</strong>
        </div>
      </section>

      <section className="info-section">
        <div className="info-section-heading">
          <Info size={19} />
          <h2>Category field</h2>
        </div>
        <p>
          Category describes what kind of record the place is. It is separate from size, so a dedicated playground can
          also be Pocket, Neighbourhood, Large, or Destination-sized.
        </p>
        <DefinitionList items={TYPE_FILTERS} />
        <p>{dataset?.dataQuality || "Area values and point coordinates are loaded from the bundled dataset."}</p>
      </section>

      <section className="info-section">
        <div className="info-section-heading">
          <Ruler size={19} />
          <h2>Size field</h2>
        </div>
        <p>
          Size is joined from the NParks managed-area polygon dataset. It is useful for judging whether a location is a
          pocket, neighbourhood, large, or destination-sized outing, but it is not a measured footprint of the actual play
          equipment.
        </p>
        <DefinitionList items={AREA_CATEGORY_DEFINITIONS} />
      </section>

      <section className="info-section">
        <div className="info-section-heading">
          <Info size={19} />
          <h2>Refresh model</h2>
        </div>
        <p>
          The app checks its bundled playground JSON once per hour while a browser tab is open. A scheduled GitHub
          Actions workflow also rebuilds the dataset hourly from data.gov.sg and commits only when the generated file
          actually changes.
        </p>
      </section>

      <section className="info-section">
        <div className="info-section-heading">
          <MapPin size={19} />
          <h2>Sources</h2>
        </div>
        <ul>
          {(dataset?.sources || []).map((source) => (
            <li key={source.datasetId}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.name}
              </a>
              : {source.use}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function PlaygroundDetail({ playground, distanceMeters }) {
  const amenities = playground.amenities?.filter((item) => !/^description$/i.test(item)).slice(0, 6) || [];

  return (
    <article className="detail-card">
      <div className="detail-heading">
        <div className="provider-line">
          <span className="type-pill">{playground.type}</span>
          <span className="status-pill available">{playground.region}</span>
        </div>
        <h2>{playground.name}</h2>
        <p>{playground.address || playground.coordinateLabel}</p>
      </div>

      <div className="detail-grid">
        <Metric label="Managed area" value={playground.areaLabel} />
        <Metric label="Size option" value={playground.areaCategory} />
        <Metric label="Distance" value={formatDistanceMeters(distanceMeters)} />
      </div>

      <div className="classification-notes" aria-label="Category and size definitions">
        <DefinitionRow label="Category" value={playground.type} definition={getTypeDefinition(playground.type)} />
        <DefinitionRow
          label="Size option"
          value={playground.areaCategory}
          definition={getAreaDefinition(playground.areaCategory)}
        />
      </div>

      <div className="detail-meta">
        <a href={playground.googleMapsUrl} target="_blank" rel="noreferrer">
          <MapPin size={15} />
          {playground.coordinateLabel}
        </a>
        <span>
          <Info size={15} />
          {playground.notes?.[1] || "Area details are based on the official source where available."}
        </span>
      </div>

      <div className="detail-actions">
        <a
          className="primary-action"
          href={playground.googleMapsUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${playground.name} in Google Maps`}
        >
          <Navigation size={18} />
          Open in Google Maps
        </a>
        <a className="secondary-action" href={playground.sourceUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={18} />
          View source dataset
        </a>
      </div>

      <div className="connector-strip">
        <span>{playground.source}</span>
        {amenities.map((amenity) => (
          <span key={amenity}>{amenity}</span>
        ))}
      </div>
    </article>
  );
}

function DefinitionList({ items }) {
  return (
    <div className="definition-list">
      {items.map((item) => (
        <DefinitionRow definition={item.definition} key={item.value} value={item.label} />
      ))}
    </div>
  );
}

function DefinitionRow({ definition, label, value }) {
  return (
    <div className="definition-row">
      {label ? <span>{label}</span> : null}
      <strong>{value}</strong>
      <p>{definition}</p>
    </div>
  );
}

function FilterGroupLabel({ description, label }) {
  return (
    <span className="filter-group-label">
      <b>{label}</b>
      <small>{description}</small>
    </span>
  );
}

function FilterChip({ active, count, description, label, onSelect }) {
  return (
    <button
      className={active ? "chip active" : "chip"}
      type="button"
      onClick={onSelect}
      aria-label={description ? `${label}. ${description}. ${formatCompactCount(count)} records.` : undefined}
      aria-pressed={active}
      title={description}
    >
      <span className="chip-icon" aria-hidden="true">
        <MapPin size={14} />
      </span>
      <span>{label}</span>
      <span className="chip-count">{formatCompactCount(count)}</span>
    </button>
  );
}

function StatTile({ label, value, tone }) {
  return (
    <div className={`stat-tile ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusDot({ category }) {
  const className = `status-dot ${normalizeText(category).replace(/\s+/g, "-")}`;
  return <span className={className} aria-hidden="true" />;
}

function MapBridge({ mapRef, onCenterChange }) {
  const map = useMap();

  useEffect(() => {
    mapRef.current = map;
  }, [map, mapRef]);

  useEffect(() => {
    function syncCenter() {
      const center = map.getCenter();
      onCenterChange([center.lat, center.lng]);
    }

    syncCenter();
    map.on("moveend zoomend", syncCenter);

    return () => {
      map.off("moveend zoomend", syncCenter);
    };
  }, [map, onCenterChange]);

  return null;
}

function createPlaygroundIcon(playground, selected) {
  const color = getPlaygroundColor(playground);
  const className = ["pin", selected ? "selected" : "", playground.type === "Park with playground" ? "park-pin" : ""].join(
    " ",
  );

  return L.divIcon({
    className: "playground-marker",
    html: `<span class="${className}" style="--pin-color: ${color}" title="${escapeAttribute(playground.name)}"><span class="pin-label">${escapeHtml(getPinLabel(playground))}</span></span>`,
    iconSize: selected ? [36, 36] : [28, 28],
    iconAnchor: selected ? [18, 18] : [14, 14],
  });
}

function createUserIcon() {
  return L.divIcon({
    className: "user-marker",
    html: '<span class="user-pin"><span></span></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function getPinLabel(playground) {
  if (playground.type === "Park with playground") return "PK";
  if (playground.areaCategory === "Destination") return "D";
  if (playground.areaCategory === "Large") return "L";
  return "PG";
}

function getPlaygroundColor(playground) {
  if (playground.type === "Park with playground") return "#0f8b5f";
  if (playground.areaCategory === "Destination") return "#0f4c81";
  if (playground.areaCategory === "Large") return "#08a7d8";
  if (playground.areaCategory === "Pocket") return "#f97316";
  return "#18bf73";
}

function createDefaultFilters() {
  return {
    types: [],
    sizes: [],
    regions: [],
  };
}

function playgroundPassesFilters(playground, filters, searchTokens) {
  const matchesType = filters.types.length === 0 || filters.types.includes(playground.type);
  const matchesSize = filters.sizes.length === 0 || filters.sizes.includes(playground.areaCategory);
  const matchesRegion = filters.regions.length === 0 || filters.regions.includes(playground.region);
  const haystack = normalizeText(
    [
      playground.name,
      playground.rawName,
      playground.type,
      playground.region,
      playground.areaCategory,
      playground.address,
      playground.amenities?.join(" "),
    ].join(" "),
  );
  const matchesSearch = searchTokens.length === 0 || searchTokens.every((token) => haystack.includes(token));

  return matchesType && matchesSize && matchesRegion && matchesSearch;
}

function rankPlaygroundsByDistance(origin, playgrounds, searchTokens = []) {
  return playgrounds
    .map((playground) => ({
      playground,
      distanceMeters: getDistanceMeters(origin, [playground.latitude, playground.longitude]),
      searchScore: getSearchScore(playground, searchTokens),
    }))
    .sort((a, b) => {
      if (a.searchScore !== b.searchScore) return b.searchScore - a.searchScore;
      if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters;
      return a.playground.name.localeCompare(b.playground.name);
    });
}

function getSearchScore(playground, searchTokens) {
  if (searchTokens.length === 0) return 0;

  const name = normalizeText(playground.name);
  const region = normalizeText(playground.region);
  let score = 0;

  searchTokens.forEach((token) => {
    if (name.startsWith(token)) score += 8;
    if (name.includes(token)) score += 4;
    if (region === token) score += 2;
  });

  return score;
}

function buildStats(playgrounds) {
  return {
    dedicatedCount: playgrounds.filter((playground) => playground.type === "Dedicated playground").length,
    parkWithPlaygroundCount: playgrounds.filter((playground) => playground.type === "Park with playground").length,
    pocketCount: playgrounds.filter((playground) => playground.areaCategory === "Pocket").length,
    largeCount: playgrounds.filter((playground) => ["Large", "Destination"].includes(playground.areaCategory)).length,
    destinationCount: playgrounds.filter((playground) => playground.areaCategory === "Destination").length,
  };
}

function getTypeDefinition(type) {
  return TYPE_FILTERS.find((item) => item.value === type)?.definition || "Category is loaded from the source dataset.";
}

function getAreaDefinition(category) {
  return (
    AREA_CATEGORY_DEFINITIONS.find((item) => item.value === category)?.definition ||
    "Size option is derived from the official managed-area size where available."
  );
}

function getActiveFilterCount(filters) {
  return filters.types.length + filters.sizes.length + filters.regions.length;
}

function toggleValue(values, value) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function getInitialSheetMode() {
  if (typeof window === "undefined") return "expanded";

  return window.matchMedia(MOBILE_SHEET_QUERY).matches ? "collapsed" : "expanded";
}

function zoomToLocationAndPlayground(map, location, playground) {
  if (!map) return;

  const playgroundLocation = [playground.latitude, playground.longitude];
  const bounds = L.latLngBounds([location, playgroundLocation]);

  if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
    map.flyTo(playgroundLocation, 17, { duration: 0.45 });
    return;
  }

  map.flyToBounds(bounds, {
    duration: 0.45,
    maxZoom: 17,
    padding: [48, 48],
  });
}

function getDistanceMeters(start, end) {
  const earthRadiusMeters = 6371000;
  const startLatitude = toRadians(start[0]);
  const endLatitude = toRadians(end[0]);
  const deltaLatitude = toRadians(end[0] - start[0]);
  const deltaLongitude = toRadians(end[1] - start[1]);
  const a =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(deltaLongitude / 2) * Math.sin(deltaLongitude / 2);

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistanceMeters(distanceMeters) {
  if (!Number.isFinite(distanceMeters)) return "TBC";
  if (distanceMeters < 50) return "< 50 m";
  if (distanceMeters < 1000) return `${Math.round(distanceMeters / 10) * 10} m`;
  if (distanceMeters < 10000) return `${(distanceMeters / 1000).toFixed(1)} km`;

  return `${Math.round(distanceMeters / 1000)} km`;
}

function formatAccuracyMeters(accuracyMeters) {
  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return "unknown";
  if (accuracyMeters < 1000) return `+/- ${Math.round(accuracyMeters)} m`;

  return `+/- ${(accuracyMeters / 1000).toFixed(1)} km`;
}

function getLocationErrorMessage(error) {
  if (error?.code === 1) return "Location permission is blocked. Enable browser location to find nearby playgrounds.";
  if (error?.code === 3) return "Location timed out. Try again or check that precise location is enabled.";

  return "Location unavailable. Enable browser location to find nearby playgrounds.";
}

function formatDate(value) {
  if (!value) return "TBC";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "TBC";

  return new Intl.DateTimeFormat("en-SG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatCompactCount(value) {
  return Number(value || 0).toLocaleString("en-SG");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isSameMapCenter(current, next) {
  return Math.abs(current[0] - next[0]) < 0.000001 && Math.abs(current[1] - next[1]) < 0.000001;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
