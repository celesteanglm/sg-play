import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import {
  ArrowLeft,
  ChevronsUp,
  CircleDot,
  CloudSun,
  Droplets,
  ExternalLink,
  Filter,
  Info,
  LocateFixed,
  MapPin,
  Navigation,
  Ruler,
  Search,
  Shovel,
  SlidersHorizontal,
  ThermometerSun,
  Trees,
  Umbrella,
  X,
} from "lucide-react";
import { trackPageView } from "./lib/analytics.js";

const SINGAPORE_CENTER = [1.3521, 103.8198];
const DEFAULT_ZOOM = 12;
const MOBILE_SHEET_QUERY = "(max-width: 860px)";
const SHEET_DRAG_THRESHOLD_PX = 44;
const RESULT_PAGE_SIZE = 16;
const PLAYGROUND_REFRESH_MS = 60 * 60 * 1000;
const WEATHER_REFRESH_MS = 30 * 60 * 1000;
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
const FEATURE_FILTERS = [
  {
    value: "sand",
    label: "Sand listed",
    definition: "Parks@SG lists a sand play area for this location.",
  },
];

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
  const [weather, setWeather] = useState(null);
  const [weatherError, setWeatherError] = useState("");
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
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const filterShellRef = useRef(null);
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
    let mounted = true;
    let refreshTimer = null;

    async function loadWeather() {
      try {
        const response = await fetch(`/api/weather?refresh=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Weather returned ${response.status}`);
        const payload = await response.json();
        if (!mounted) return;

        if (!payload.ok) throw new Error(payload.warning || "Weather forecast unavailable.");
        setWeather(payload);
        setWeatherError("");
      } catch (error) {
        if (!mounted) return;

        setWeather(null);
        setWeatherError(error instanceof Error ? error.message : "Weather forecast unavailable.");
      }
    }

    loadWeather();
    refreshTimer = window.setInterval(loadWeather, WEATHER_REFRESH_MS);

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
  const extendedFilterCount = filters.sizes.length + filters.features.length + filters.regions.length;
  const filterPanelId = "playground-filter-panel";
  const hasMoreResults = visiblePlaygrounds.length < rankedPlaygrounds.length;

  useEffect(() => {
    setVisibleResultCount(RESULT_PAGE_SIZE);
  }, [filters, query, rankingOrigin]);

  useEffect(() => {
    if (!isFilterPanelOpen) return;

    function handlePointerDown(event) {
      if (filterShellRef.current?.contains(event.target)) return;
      setIsFilterPanelOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") setIsFilterPanelOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFilterPanelOpen]);

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

  function renderTypeFilterChips() {
    return TYPE_FILTERS.map((type) => (
      <FilterChip
        active={filters.types.includes(type.value)}
        count={playgrounds.filter((playground) => playground.type === type.value).length}
        description={type.definition}
        key={type.value}
        label={type.label}
        onSelect={() => toggleTypeFilter(type.value)}
      />
    ));
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

          <WeatherBrief weather={weather} error={weatherError} />

          <div className="filter-shell" ref={filterShellRef}>
            <div className="filter-bar" aria-label="Playground filters">
              <div className="filter-quick-chips">
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
                {renderTypeFilterChips()}
              </div>
              <button
                className={[
                  "filter-panel-toggle",
                  isFilterPanelOpen ? "open" : "",
                  extendedFilterCount > 0 ? "has-filters" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                type="button"
                onClick={() => setIsFilterPanelOpen((current) => !current)}
                aria-controls={filterPanelId}
                aria-expanded={isFilterPanelOpen}
                aria-label="Open size, sand, region, and category filters"
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>More</span>
                {extendedFilterCount > 0 ? <span className="filter-badge">{extendedFilterCount}</span> : null}
              </button>
            </div>

            {isFilterPanelOpen ? (
              <div className="filter-panel" id={filterPanelId} aria-label="More playground filters">
                <FilterSection title="Category" description="Dedicated playgrounds and parks with playground amenities.">
                  {renderTypeFilterChips()}
                </FilterSection>
                <FilterSection
                  title="Size option"
                  description="Pocket is a managed-area size filter, separate from the playground category."
                >
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
                </FilterSection>
                <FilterSection title="Play feature" description="Amenities that can change the outing plan.">
                  {FEATURE_FILTERS.map((feature) => (
                    <FilterChip
                      active={filters.features.includes(feature.value)}
                      count={playgrounds.filter((playground) => playgroundMatchesFeature(playground, feature.value)).length}
                      description={feature.definition}
                      key={feature.value}
                      label={feature.label}
                      onSelect={() => toggleArrayFilter("features", feature.value)}
                    />
                  ))}
                </FilterSection>
                <FilterSection title="Region" description="Narrow the map to an area of Singapore.">
                  {REGION_FILTERS.map((region) => (
                    <FilterChip
                      active={filters.regions.includes(region)}
                      count={playgrounds.filter((playground) => playground.region === region).length}
                      key={region}
                      label={region}
                      onSelect={() => toggleArrayFilter("regions", region)}
                    />
                  ))}
                </FilterSection>
              </div>
            ) : null}
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
                <a href={getGoogleMapsUrl(playground)} target="_blank" rel="noreferrer">
                  Open in Google Maps
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
            <StatTile label="Sand listed" value={formatCompactCount(stats.sandListedCount)} tone="dark" />
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
                  {getSandStatus(playground).kind === "listed" ? <span className="sand-badge row-sand">Sand</span> : null}
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
          <strong>Direct Google Maps</strong>
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
          <Shovel size={19} />
          <h2>Parent planning fields</h2>
        </div>
        <p>
          Sand status is derived from Parks@SG amenities. If a record does not publish amenity details, the app marks
          sand information as unavailable instead of assuming the surface.
        </p>
        <DefinitionList
          items={[
            {
              value: "Sand play listed",
              label: "Sand play listed",
              definition: "Parks@SG explicitly lists Sand play area for this location.",
            },
            {
              value: "No sand listed",
              label: "No sand listed",
              definition: "Amenities are published, but Sand play area is not listed.",
            },
            {
              value: "Sand info unavailable",
              label: "Sand info unavailable",
              definition: "No official amenity data was available for this playground record.",
            },
            {
              value: "Today in SG weather",
              label: "Weather planning",
              definition:
                "Today and the official 4-day outlook use NEA/data.gov.sg; days 5-7 are model forecasts from Open-Meteo when available.",
            },
          ]}
        />
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
  const sandStatus = getSandStatus(playground);

  return (
    <article className="detail-card">
      <div className="detail-heading">
        <div className="provider-line">
          <span className="type-pill">{playground.type}</span>
          <span className="status-pill available">{playground.region}</span>
          <span className={`sand-pill ${sandStatus.kind}`}>
            <Shovel size={13} aria-hidden="true" />
            {sandStatus.label}
          </span>
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
        <DefinitionRow label="Sand" value={sandStatus.label} definition={sandStatus.definition} />
      </div>

      <div className="detail-meta">
        <a href={getGoogleMapsUrl(playground)} target="_blank" rel="noreferrer">
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
          href={getGoogleMapsUrl(playground)}
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

function WeatherBrief({ error, weather }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedForecastIndex, setSelectedForecastIndex] = useState(0);
  const forecastDays = weather?.weeklyOutlook?.length ? weather.weeklyOutlook : weather?.outlook || [];
  const panelId = "weather-details-panel";

  useEffect(() => {
    if (selectedForecastIndex >= forecastDays.length) {
      setSelectedForecastIndex(0);
    }
  }, [forecastDays.length, selectedForecastIndex]);

  if (!weather && !error) {
    return (
      <section className="weather-card loading" aria-label="Singapore weather forecast">
        <CloudSun size={20} aria-hidden="true" />
        <div>
          <span>Today in SG</span>
          <strong>Loading weather</strong>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="weather-card warning" aria-label="Singapore weather forecast">
        <Umbrella size={20} aria-hidden="true" />
        <div>
          <span>Today in SG</span>
          <strong>Weather unavailable</strong>
          <p>{error}</p>
        </div>
      </section>
    );
  }

  const day = weather.day || {};
  const period = day.periods?.[0];
  const selectedForecast = forecastDays[selectedForecastIndex] || forecastDays[0] || null;

  return (
    <section className={isExpanded ? "weather-card expanded" : "weather-card"} aria-label="Singapore weather forecast">
      <div className="weather-main">
        <span className="weather-icon" aria-hidden="true">
          <CloudSun size={21} />
        </span>
        <div className="weather-copy">
          <span>Today in SG</span>
          <strong>{day.forecastText || "Forecast updating"}</strong>
        </div>
      </div>

      <div className="weather-metrics" aria-label="Weather summary">
        <span>
          <ThermometerSun size={14} aria-hidden="true" />
          {day.temperature?.label || "Temp TBC"}
        </span>
        <span>
          <Droplets size={14} aria-hidden="true" />
          {day.humidity?.label || "Humidity TBC"}
        </span>
        <span className="weather-period-chip">
          <Umbrella size={14} aria-hidden="true" />
          {period ? formatRegionalForecast(period) : day.validText || "24-hour forecast"}
        </span>
      </div>

      <button
        className="weather-info-button"
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        aria-controls={panelId}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "Hide weather details" : "Show weather details"}
        title={isExpanded ? "Hide weather details" : "Show weather details"}
      >
        <Info size={16} aria-hidden="true" />
      </button>

      {isExpanded && forecastDays.length > 0 ? (
        <div className="weather-expanded-panel" id={panelId}>
          <div className="weather-expanded-heading">
            <div>
              <span>{weather.outlookLabel || `Next ${forecastDays.length} days`}</span>
              <strong>Weather planning</strong>
            </div>
            <button type="button" onClick={() => setIsExpanded(false)} aria-label="Close weather details">
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          <p className="weather-parent-cue">{weather.parentCue || "Check the forecast before heading out."}</p>

          <div className="weather-outlook-header">
            <span>Daily outlook</span>
            <small>Tap a day for details</small>
          </div>

          <div className="weather-outlook" aria-label={weather.outlookLabel || "Weather outlook"}>
            {forecastDays.map((forecast, index) => (
              <button
                className={index === selectedForecastIndex ? "active" : ""}
                key={`${forecast.day}-${forecast.date}`}
                type="button"
                onClick={() => setSelectedForecastIndex(index)}
                aria-pressed={index === selectedForecastIndex}
              >
                <b>{getForecastDayLabel(forecast)}</b>
                <span>{forecast.forecastText || "Forecast"}</span>
                <small>{forecast.temperature?.label || "Temp TBC"}</small>
              </button>
            ))}
          </div>

          {selectedForecast ? (
            <div className="weather-day-detail" aria-live="polite">
              <div className="weather-day-heading">
                <span>{formatForecastDate(selectedForecast.date)}</span>
                <strong>{selectedForecast.summary || selectedForecast.forecastText || "Forecast details"}</strong>
              </div>
              <div className="weather-detail-grid">
                <WeatherDetailMetric label="Temp" value={selectedForecast.temperature?.label} />
                <WeatherDetailMetric label="Feels like" value={selectedForecast.apparentTemperature?.label} />
                <WeatherDetailMetric label="Humidity" value={selectedForecast.humidity?.label} />
                <WeatherDetailMetric label="Rain chance" value={selectedForecast.precipitationProbability?.label} />
                <WeatherDetailMetric label="Rain" value={selectedForecast.precipitation?.label} />
                <WeatherDetailMetric label="Wind" value={selectedForecast.wind?.label} />
                <WeatherDetailMetric label="UV" value={selectedForecast.uvIndex?.label} />
              </div>
              <p className="weather-source-note">{selectedForecast.sourceNote || weather.outlookNote}</p>
            </div>
          ) : null}

          {weather.outlookNote ? (
            <p className="weather-source-note weather-outlook-note">{weather.outlookNote}</p>
          ) : null}
          {weather.weeklyWarning ? (
            <p className="weather-source-note weather-outlook-note">{weather.weeklyWarning}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function WeatherDetailMetric({ label, value }) {
  if (!value) return null;

  return (
    <span className="weather-detail-metric">
      <b>{label}</b>
      {value}
    </span>
  );
}

function getForecastDayLabel(forecast) {
  if (forecast.day) return forecast.day.slice(0, 3);

  return formatForecastDate(forecast.date, { weekday: "short" });
}

function formatForecastDate(value, options = {}) {
  if (!value) return "Date TBC";

  const date = new Date(String(value).includes("T") ? value : `${value}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "Date TBC";

  return new Intl.DateTimeFormat("en-SG", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Singapore",
    weekday: options.weekday || "short",
  }).format(date);
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

function FilterSection({ children, description, title }) {
  return (
    <section className="filter-section">
      <div className="filter-section-heading">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="filter-chip-grid">{children}</div>
    </section>
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
    features: [],
    types: [],
    sizes: [],
    regions: [],
  };
}

function playgroundPassesFilters(playground, filters, searchTokens) {
  const matchesType = filters.types.length === 0 || filters.types.includes(playground.type);
  const matchesSize = filters.sizes.length === 0 || filters.sizes.includes(playground.areaCategory);
  const matchesRegion = filters.regions.length === 0 || filters.regions.includes(playground.region);
  const matchesFeature =
    filters.features.length === 0 || filters.features.every((feature) => playgroundMatchesFeature(playground, feature));
  const sandStatus = getSandStatus(playground);
  const haystack = normalizeText(
    [
      playground.name,
      playground.rawName,
      playground.type,
      playground.region,
      playground.areaCategory,
      sandStatus.label,
      sandStatus.definition,
      playground.address,
      playground.amenities?.join(" "),
    ].join(" "),
  );
  const matchesSearch = searchTokens.length === 0 || searchTokens.every((token) => haystack.includes(token));

  return matchesType && matchesSize && matchesRegion && matchesFeature && matchesSearch;
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
    sandListedCount: playgrounds.filter((playground) => getSandStatus(playground).kind === "listed").length,
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
  return filters.types.length + filters.sizes.length + filters.regions.length + filters.features.length;
}

function playgroundMatchesFeature(playground, feature) {
  if (feature === "sand") return getSandStatus(playground).kind === "listed";

  return false;
}

function getSandStatus(playground) {
  const amenityText = (playground.amenities || []).join(" ");

  if (/\bsand\s+play\b|\bsand\s+play\s+area\b/i.test(amenityText)) {
    return {
      kind: "listed",
      label: "Sand play listed",
      definition: "Parks@SG explicitly lists a sand play area for this location.",
    };
  }

  if ((playground.amenities || []).length > 0 || /Parks@SG/i.test(playground.source || "")) {
    return {
      kind: "not-listed",
      label: "No sand listed",
      definition: "Published amenities do not list a sand play area.",
    };
  }

  return {
    kind: "unknown",
    label: "Sand info unavailable",
    definition: "No official amenity or surface details were published for this record.",
  };
}

function getGoogleMapsUrl(playground) {
  const latitude = Number(playground.latitude);
  const longitude = Number(playground.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return playground.googleMapsUrl || "#";
  }

  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", `${latitude},${longitude}`);
  return url.toString();
}

function formatRegionalForecast(period) {
  const regions = period.regions || [];
  const uniqueForecasts = [...new Set(regions.map((region) => region.forecastText).filter(Boolean))];

  if (uniqueForecasts.length === 1) return uniqueForecasts[0];
  if (uniqueForecasts.length > 1) return "Mixed by region";

  return period.label || "24-hour forecast";
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
