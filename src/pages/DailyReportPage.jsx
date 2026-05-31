import React from 'react';
import { useHistory, useIncidents, usePatrol, useShips, useSOS, useUI } from '../context/AppContextRuntime';
import AsyncImage from '../components/AsyncImage';
import { TimeAuditPills } from '../components/TimeAuditStatus';
import {
  Activity,
  AlertTriangle,
  Anchor,
  BarChart3,
  CalendarRange,
  CheckCircle2,
  CircleAlert,
  CircleOff,
  ShieldAlert,
  UserRound,
} from 'lucide-react';

const APP_TIME_ZONE = 'Asia/Jakarta';

const keyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const shortDateFormatter = new Intl.DateTimeFormat('id-ID', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
  month: 'short',
});

const chartDayFormatter = new Intl.DateTimeFormat('id-ID', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
});

const chartMonthFormatter = new Intl.DateTimeFormat('id-ID', {
  timeZone: APP_TIME_ZONE,
  month: 'short',
});

const longDateFormatter = new Intl.DateTimeFormat('id-ID', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
  month: 'long',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('id-ID', {
  timeZone: APP_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function getDateKey(value) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return keyFormatter.format(parsed);
}

function formatDateKey(value) {
  if (!value) return '-';
  const parsed = new Date(`${value}T00:00:00+07:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return longDateFormatter.format(parsed);
}

function getChartAxisLabel(dateKey, previousDateKey, isBoundary = false) {
  if (!dateKey) {
    return { primary: '', secondary: '' };
  }

  const currentDate = new Date(`${dateKey}T00:00:00+07:00`);
  if (Number.isNaN(currentDate.getTime())) {
    return { primary: dateKey, secondary: '' };
  }

  const previousDate = previousDateKey
    ? new Date(`${previousDateKey}T00:00:00+07:00`)
    : null;

  const primary = chartDayFormatter.format(currentDate);
  const showMonth = isBoundary
    || !previousDate
    || previousDate.getMonth() !== currentDate.getMonth()
    || previousDate.getFullYear() !== currentDate.getFullYear();

  return {
    primary,
    secondary: showMonth ? chartMonthFormatter.format(currentDate) : '',
  };
}

function formatDateTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return dateTimeFormatter.format(parsed);
}

function formatMetricNumber(value, digits = 0) {
  return new Intl.NumberFormat('id-ID', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value || 0);
}

function buildSvgLinePath(points = []) {
  if (!points.length) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

function buildSvgAreaPath(points = [], baselineY = 0) {
  if (!points.length) return '';
  const linePath = buildSvgLinePath(points);
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  return `${linePath} L ${lastPoint.x} ${baselineY} L ${firstPoint.x} ${baselineY} Z`;
}

function createRangeDays(startKey, endKey) {
  if (!startKey || !endKey || startKey > endKey) return [];

  const days = [];
  const cursor = new Date(`${startKey}T00:00:00+07:00`);
  const end = new Date(`${endKey}T00:00:00+07:00`);

  while (cursor.getTime() <= end.getTime()) {
    days.push(getDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function createQuickRange(daysBack = 0) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - daysBack);
  return {
    from: getDateKey(start),
    to: getDateKey(end),
  };
}

function summarizeCheckpoints(checkpoints = []) {
  return checkpoints.reduce((summary, checkpoint) => {
    summary.total += 1;
    if (checkpoint.status === 'completed') {
      summary.completed += 1;
      if (checkpoint.resultType === 'aman') summary.aman += 1;
      if (checkpoint.resultType === 'temuan') summary.temuan += 1;
    }
    if (checkpoint.status === 'missed' || checkpoint.resultType === 'missed') {
      summary.missed += 1;
    }
    return summary;
  }, { total: 0, completed: 0, aman: 0, temuan: 0, missed: 0 });
}

function getCompletionRate(completed, total) {
  if (!total) return 0;
  return (completed / total) * 100;
}

function getProgressTone(rate) {
  if (rate >= 90) return 'from-emerald-400 via-emerald-500 to-cyan-400';
  if (rate >= 70) return 'from-cyan-400 via-cyan-500 to-yellow-400';
  if (rate >= 50) return 'from-yellow-400 via-amber-500 to-orange-400';
  return 'from-rose-400 via-rose-500 to-orange-400';
}

function normalizeIncidentTimestamp(incident) {
  const timestamp = (
    Number.isFinite(incident?.occurredAtTrustedMs)
      ? incident.occurredAtTrustedMs
      : new Date(
        incident?.occurredAtTrustedIso
        || incident?.completedAt
        || incident?.createdAt
        || '',
      ).getTime()
  );

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function buildProgressTimestamp(progressItem) {
  if (!progressItem) return 0;
  const timestamp = (
    Number.isFinite(progressItem?.occurredAtTrustedMs)
      ? progressItem.occurredAtTrustedMs
      : new Date(
        progressItem?.occurredAtTrustedIso
        || progressItem?.createdAt
        || `${progressItem.date || ''} ${progressItem.time || ''}`
      ).getTime()
  );
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function MetricCard({ title, value, subtitle, accentClass, icon, children }) {
  return (
    <div className="rounded-[1.75rem] border border-cyan-800/50 bg-[#0b1229] p-5 shadow-[0_0_24px_rgba(8,145,178,0.08)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-500">{title}</p>
          <p className={`mt-3 text-3xl font-black ${accentClass}`}>{value}</p>
          {subtitle ? <p className="mt-2 text-xs text-cyan-300/75 metric-subtitle">{subtitle}</p> : null}
        </div>
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl border ${accentClass.includes('emerald') ? 'border-emerald-500/30 bg-emerald-500/10' : accentClass.includes('rose') ? 'border-rose-500/30 bg-rose-500/10' : accentClass.includes('yellow') ? 'border-yellow-500/30 bg-yellow-500/10' : 'border-cyan-500/30 bg-cyan-500/10'}`}>
          {icon}
        </div>
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

function EmptyState({ title, description, icon }) {
  return (
    <div className="rounded-[1.5rem] border border-dashed border-cyan-900/50 bg-[#0b1229]/35 p-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-900/20 text-cyan-700">
        {icon}
      </div>
      <p className="text-sm font-black uppercase tracking-widest text-cyan-400">{title}</p>
      <p className="mt-2 text-xs leading-relaxed text-cyan-700">{description}</p>
    </div>
  );
}

class SectionErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error('Daily report section failed to render', error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || null;
    }
    return this.props.children;
  }
}

const CHART_SERIES = [
  {
    key: 'aman',
    label: 'Aman',
    shortLabel: 'Aman',
    stroke: '#34d399',
    fill: 'rgba(52,211,153,0.14)',
  },
  {
    key: 'temuan',
    label: 'Temuan',
    shortLabel: 'Temuan',
    stroke: '#facc15',
    fill: 'rgba(250,204,21,0.14)',
  },
  {
    key: 'missed',
    label: 'Missed',
    shortLabel: 'Missed',
    stroke: '#fb7185',
    fill: 'rgba(251,113,133,0.14)',
  },
];

const QUICK_FILTERS = [
  { id: 'today', label: 'Today', daysBack: 0 },
  { id: 'three-days', label: '3D', daysBack: 2 },
  { id: 'week', label: '7D', daysBack: 6 },
  { id: 'month', label: '30D', daysBack: 29 },
];

function DailyReportTrendChart({ chartData }) {
  const xAxisLabelStep = React.useMemo(() => {
    if (chartData.length <= 7) return 1;
    if (chartData.length <= 14) return 2;
    if (chartData.length <= 21) return 3;
    return 4;
  }, [chartData.length]);

  const chartMaxValue = React.useMemo(() => {
    return Math.max(
      10,
      ...chartData.map((item) => Math.max(
        item.aman || 0,
        item.temuan || 0,
        item.missed || 0,
      )),
    );
  }, [chartData]);

  const chartSvg = React.useMemo(() => {
    const width = 1080;
    const height = 260;
    const topPadding = 20;
    const bottomPadding = 42;
    const sidePadding = 22;
    const usableHeight = height - topPadding - bottomPadding;
    const baselineY = height - bottomPadding;
    const stepX = chartData.length > 1
      ? (width - (sidePadding * 2)) / (chartData.length - 1)
      : 0;

    const pointsBySeries = CHART_SERIES.reduce((accumulator, series) => {
      accumulator[series.key] = chartData.map((item, index) => {
        const rawValue = Number(item[series.key] || 0);
        const x = chartData.length > 1
          ? sidePadding + (index * stepX)
          : width / 2;
        const y = baselineY - ((rawValue / chartMaxValue) * usableHeight);
        return {
          x,
          y,
          rawValue,
          dateKey: item.dateKey,
          label: item.label,
        };
      });
      return accumulator;
    }, {});

    const yGuides = 4;
    const guideLines = Array.from({ length: yGuides + 1 }, (_, index) => {
      const value = (chartMaxValue / yGuides) * index;
      const y = baselineY - ((value / chartMaxValue) * usableHeight);
      return { value, y };
    });

    return {
      width,
      height,
      baselineY,
      guideLines,
      pointsBySeries,
    };
  }, [chartData, chartMaxValue]);

  return (
    <div className="mt-6">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest">
        {CHART_SERIES.map((series) => (
          <span
            key={series.key}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[#070b19] px-2.5 py-1"
            style={{ color: series.stroke }}
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: series.stroke }}
            ></span>
            {series.shortLabel}
          </span>
        ))}
      </div>
      <div className="overflow-hidden rounded-[1.5rem] border border-cyan-800/40 bg-[#070b19] px-0 py-3">
        <svg
          viewBox={`0 0 ${chartSvg.width} ${chartSvg.height}`}
          preserveAspectRatio="xMidYMid meet"
          className="h-72 w-full"
        >
          {chartSvg.guideLines.map((guide) => (
            <g key={`guide-${guide.value}`}>
              <line
                x1="0"
                y1={guide.y}
                x2={chartSvg.width}
                y2={guide.y}
                stroke="rgba(34,211,238,0.12)"
                strokeDasharray="4 6"
              />
              <text
                x="10"
                y={guide.y - 4}
                fill="rgba(103,232,249,0.55)"
                fontSize="10"
                fontWeight="700"
                className="chart-axis-text"
              >
                {formatMetricNumber(guide.value, guide.value % 1 === 0 ? 0 : 1)}
              </text>
            </g>
          ))}

          {CHART_SERIES.map((series) => {
            const points = chartSvg.pointsBySeries[series.key] || [];
            return (
              <g key={series.key}>
                <path
                  d={buildSvgAreaPath(points, chartSvg.baselineY)}
                  fill={series.fill}
                />
                <path
                  d={buildSvgLinePath(points)}
                  fill="none"
                  stroke={series.stroke}
                  strokeWidth="3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {points.map((point, index) => (
                  <g key={`${series.key}-${point.dateKey}`}>
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r="3.5"
                      fill={series.stroke}
                      stroke="#0b1229"
                      strokeWidth="1.5"
                    >
                      <title>{`${point.label} - ${series.label}: ${formatMetricNumber(point.rawValue, 0)}`}</title>
                    </circle>
                  </g>
                ))}
              </g>
            );
          })}

          {(() => {
            let previousRenderedDateKey = null;

            return chartData.map((day, index) => {
            const points = chartSvg.pointsBySeries.aman || [];
            const anchorPoint = points[index];
            if (!anchorPoint) return null;
            const shouldRenderLabel = index === 0
              || index === chartData.length - 1
              || index % xAxisLabelStep === 0;

            if (!shouldRenderLabel) return null;

            const label = getChartAxisLabel(
              day.dateKey,
              previousRenderedDateKey,
              index === 0 || index === chartData.length - 1,
            );
            previousRenderedDateKey = day.dateKey;

            return (
              <g key={`label-${day.dateKey}`}>
                <text
                  x={anchorPoint.x}
                  y={chartSvg.height - 18}
                  textAnchor="middle"
                  fill="rgba(103,232,249,0.88)"
                  fontSize="10"
                  fontWeight="800"
                  className="chart-axis-text"
                >
                  {label.primary}
                </text>
                {label.secondary ? (
                  <text
                    x={anchorPoint.x}
                    y={chartSvg.height - 6}
                    textAnchor="middle"
                    fill="rgba(103,232,249,0.58)"
                    fontSize="8"
                    fontWeight="700"
                    className="chart-axis-text"
                  >
                    {label.secondary}
                  </text>
                ) : null}
              </g>
            );
            });
          })()}
        </svg>
      </div>
    </div>
  );
}

const DailyReportPage = React.memo(function DailyReportPage() {
  const { historyEntries } = useHistory();
  const { checkpoints, currentShiftMeta, activeShiftGuardSnapshot } = usePatrol();
  const { operationalShip, operationalShipName } = useShips();
  const { allIncidents, incidentMeta, setSelectedIncident } = useIncidents();
  const { sosHistory } = useSOS();
  const { setCurrentPage } = useUI();

  const initialRange = React.useMemo(() => {
    return createQuickRange(6);
  }, []);

  const [startDate, setStartDate] = React.useState(initialRange.from);
  const [endDate, setEndDate] = React.useState(initialRange.to);
  const activeQuickFilter = React.useMemo(() => {
    const activeFilter = QUICK_FILTERS.find((filter) => {
      const range = createQuickRange(filter.daysBack);
      return range.from === startDate && range.to === endDate;
    });
    return activeFilter?.id || null;
  }, [endDate, startDate]);

  const liveEntry = React.useMemo(() => {
    if (!operationalShipName || !currentShiftMeta?.dateKey) return null;

    const summary = summarizeCheckpoints(checkpoints);

    return {
      id: `live-${operationalShip?.id || operationalShipName}-${currentShiftMeta.key || currentShiftMeta.dateKey}`,
      dateKey: currentShiftMeta.dateKey,
      date: currentShiftMeta.dateLabel,
      shift: currentShiftMeta.label,
      ship: operationalShipName,
      crewSnapshot: activeShiftGuardSnapshot || [],
      weatherSnapshot: null,
      checkpoints,
      summary,
      issue: summary.temuan,
      missed: summary.missed,
      createdAt: new Date().toISOString(),
      isLive: true,
    };
  }, [
    activeShiftGuardSnapshot,
    checkpoints,
    currentShiftMeta,
    operationalShip?.id,
    operationalShipName,
  ]);

  const reportEntries = React.useMemo(() => {
    const baseEntries = [...historyEntries];
    if (liveEntry && !baseEntries.some((entry) => entry.id === liveEntry.id)) {
      baseEntries.unshift(liveEntry);
    }
    return baseEntries;
  }, [historyEntries, liveEntry]);

  const filteredEntries = React.useMemo(() => {
    return reportEntries.filter((entry) => {
      const entryDateKey = entry.dateKey || getDateKey(entry.createdAt);
      if (startDate && entryDateKey && entryDateKey < startDate) return false;
      if (endDate && entryDateKey && entryDateKey > endDate) return false;
      return true;
    });
  }, [endDate, reportEntries, startDate]);

  const dashboardMetrics = React.useMemo(() => {
    return filteredEntries.reduce((aggregate, entry) => {
      const summary = entry.summary || summarizeCheckpoints(entry.checkpoints || []);
      aggregate.total += summary.total || 0;
      aggregate.completed += summary.completed || 0;
      aggregate.aman += summary.aman || 0;
      aggregate.temuan += summary.temuan || 0;
      aggregate.missed += summary.missed || 0;
      return aggregate;
    }, { total: 0, completed: 0, aman: 0, temuan: 0, missed: 0 });
  }, [filteredEntries]);

  const filteredSos = React.useMemo(() => {
    return sosHistory.filter((item) => {
      const itemDateKey = getDateKey(item.triggeredAt);
      if (startDate && itemDateKey && itemDateKey < startDate) return false;
      if (endDate && itemDateKey && itemDateKey > endDate) return false;
      return true;
    });
  }, [endDate, sosHistory, startDate]);

  const completionRate = getCompletionRate(dashboardMetrics.completed, dashboardMetrics.total);

  const perShipBreakdown = React.useMemo(() => {
    const shipMap = new Map();

    filteredEntries.forEach((entry) => {
      const shipName = entry.ship || 'Tanpa Kapal';
      const summary = entry.summary || summarizeCheckpoints(entry.checkpoints || []);
      const currentShip = shipMap.get(shipName) || {
        ship: shipName,
        shifts: 0,
        total: 0,
        completed: 0,
        temuan: 0,
        missed: 0,
        latestEntryAt: 0,
      };

      currentShip.shifts += 1;
      currentShip.total += summary.total || 0;
      currentShip.completed += summary.completed || 0;
      currentShip.temuan += summary.temuan || 0;
      currentShip.missed += summary.missed || 0;
      currentShip.latestEntryAt = Math.max(currentShip.latestEntryAt, new Date(entry.createdAt || '').getTime() || 0);
      shipMap.set(shipName, currentShip);
    });

    filteredSos.forEach((item) => {
      const shipName = item.shipName || 'Tanpa Kapal';
      const currentShip = shipMap.get(shipName) || {
        ship: shipName,
        shifts: 0,
        total: 0,
        completed: 0,
        temuan: 0,
        missed: 0,
        latestEntryAt: 0,
      };
      currentShip.sos = (currentShip.sos || 0) + 1;
      shipMap.set(shipName, currentShip);
    });

    return Array.from(shipMap.values())
      .map((ship) => ({
        ...ship,
        sos: ship.sos || 0,
        completionRate: getCompletionRate(ship.completed, ship.total),
      }))
      .sort((left, right) => {
        if (right.temuan !== left.temuan) return right.temuan - left.temuan;
        if (right.missed !== left.missed) return right.missed - left.missed;
        return right.latestEntryAt - left.latestEntryAt;
      });
  }, [filteredEntries, filteredSos]);

  const chartDays = React.useMemo(() => createRangeDays(startDate, endDate), [endDate, startDate]);

  const chartData = React.useMemo(() => {
    return chartDays.map((dateKey) => {
      const dayEntries = filteredEntries.filter((entry) => entry.dateKey === dateKey);
      const summary = dayEntries.reduce((aggregate, entry) => {
        const itemSummary = entry.summary || summarizeCheckpoints(entry.checkpoints || []);
        aggregate.total += itemSummary.total || 0;
        aggregate.completed += itemSummary.completed || 0;
        aggregate.aman += itemSummary.aman || 0;
        aggregate.temuan += itemSummary.temuan || 0;
        aggregate.missed += itemSummary.missed || 0;
        return aggregate;
      }, { total: 0, completed: 0, aman: 0, temuan: 0, missed: 0 });

      return {
        dateKey,
        label: shortDateFormatter.format(new Date(`${dateKey}T00:00:00+07:00`)),
        completionRate: getCompletionRate(summary.completed, summary.total),
        total: summary.total,
        completed: summary.completed,
        aman: summary.aman,
        temuan: summary.temuan,
        missed: summary.missed,
        stackTotal: summary.aman + summary.temuan + summary.missed,
      };
    });
  }, [chartDays, filteredEntries]);

  const openIncidents = React.useMemo(() => {
    return allIncidents
      .filter((incident) => {
        if (incident?.isSOS) return false;
        const meta = incidentMeta[incident.id] || { status: 'open' };
        if (meta.status === 'closed') return false;
        return true;
      })
      .map((incident) => {
        const meta = incidentMeta[incident.id] || {};
        const progress = meta.progress || [];
        const latestProgress = progress.length ? progress[progress.length - 1] : null;
        const lastUpdateLabel = latestProgress?.comment || incident.tindakLanjut || incident.deskripsi || 'Belum ada update lanjutan.';
        const lastUpdateTime = latestProgress
          ? `${latestProgress.date || '-'} ${latestProgress.time || '-'}`
          : formatDateTime(incident.completedAt || incident.createdAt);

        return {
          ...incident,
          latestProgress,
          lastUpdateLabel,
          lastUpdateTime,
          progressCount: progress.length,
          createdLabel: formatDateTime(incident.completedAt || incident.createdAt),
          sortTimestamp: Math.max(
            normalizeIncidentTimestamp(incident),
            buildProgressTimestamp(latestProgress),
          ),
        };
      })
      .sort((left, right) => right.sortTimestamp - left.sortTimestamp);
  }, [allIncidents, incidentMeta]);

  const latestGuardPatrols = React.useMemo(() => {
    const latestByGuard = new Map();

    filteredEntries.forEach((entry) => {
      (entry.checkpoints || []).forEach((checkpoint) => {
        if (checkpoint.status !== 'completed') return;

        const timestamp = new Date(checkpoint.completedAt || '').getTime();
        if (Number.isNaN(timestamp)) return;

        const guardKey = checkpoint.completedByUserId || checkpoint.completedBy || `guard-${timestamp}`;
        const previousRecord = latestByGuard.get(guardKey);

        const nextRecord = {
          id: guardKey,
          name: checkpoint.completedBy || 'Petugas',
          ship: checkpoint.shipName || entry.ship || '-',
          checkpoint: checkpoint.name || '-',
          completedAt: checkpoint.completedAt,
          photoUrl: (entry.crewSnapshot || []).find((guard) => (
            guard.id === checkpoint.completedByUserId || guard.name === checkpoint.completedBy
          ))?.photoUrl || null,
        };

        if (!previousRecord || timestamp > new Date(previousRecord.completedAt || '').getTime()) {
          latestByGuard.set(guardKey, nextRecord);
        }
      });
    });

    return Array.from(latestByGuard.values())
      .sort((left, right) => new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime())
      .slice(0, 5);
  }, [filteredEntries]);

  const sosInfoEntries = React.useMemo(() => {
    return [...filteredSos]
      .map((item) => ({
        id: item.id,
        shipName: item.shipName || 'Tanpa Kapal',
        senderName: item.senderName || 'Tidak diketahui',
        senderRole: item.senderRole || 'Petugas',
        triggeredAt: item.triggeredAt || item.createdAt || null,
        status: item.status || 'active',
        ...item,
      }))
      .sort((left, right) => new Date(right.triggeredAt || 0).getTime() - new Date(left.triggeredAt || 0).getTime());
  }, [filteredSos]);

  const openIncidentDetail = React.useCallback((incident) => {
    if (!incident) return;
    setSelectedIncident(incident);
    setCurrentPage('incidents');
  }, [setCurrentPage, setSelectedIncident]);

  const applyQuickFilter = React.useCallback((daysBack) => {
    const range = createQuickRange(daysBack);
    setStartDate(range.from);
    setEndDate(range.to);
  }, []);

  return (
    <div className="min-h-full overflow-y-auto p-4 pb-8 text-cyan-50 animate-in fade-in space-y-6 scrollbar-thin scrollbar-thumb-cyan-900/50">
      <section className="rounded-[2rem] border border-cyan-800/50 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.18),transparent_35%),linear-gradient(135deg,#0b1229,#070b19_55%,#03131d)] p-5 shadow-[0_0_40px_rgba(6,182,212,0.08)] dashboard-header-card">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-2xl">
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-400">Admin Daily Report</p>
            <h2 className="mt-2 text-3xl font-black text-white">Ringkasan Penjagaan Kapal Non-Operasional</h2>
            <p className="mt-3 text-sm leading-relaxed text-cyan-200/75 dashboard-header-desc">
              Dashboard ini menyajikan rangkuman kegiatan patroli keamanan, status temuan yang belum terselesaikan, pembaruan aktivitas petugas jaga, serta informasi SOS selama periode waktu yang dipilih.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:min-w-[440px]">
            <label className="rounded-2xl border border-cyan-800/50 bg-[#070b19]/70 p-3 dashboard-secondary-box">
              <span className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-cyan-500">
                <CalendarRange className="h-3.5 w-3.5" />
                Dari Tanggal
              </span>
              <input
                type="date"
                value={startDate}
                max={endDate || undefined}
                onChange={(event) => setStartDate(event.target.value)}
                className="w-full rounded-xl border border-cyan-800/60 bg-[#0b1229] px-3 py-3 text-sm text-cyan-50 outline-none transition-colors focus:border-cyan-400"
              />
            </label>
            <label className="rounded-2xl border border-cyan-800/50 bg-[#070b19]/70 p-3 dashboard-secondary-box">
              <span className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-cyan-500">
                <CalendarRange className="h-3.5 w-3.5" />
                Sampai Tanggal
              </span>
              <input
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(event) => setEndDate(event.target.value)}
                className="w-full rounded-xl border border-cyan-800/60 bg-[#0b1229] px-3 py-3 text-sm text-cyan-50 outline-none transition-colors focus:border-cyan-400"
              />
            </label>
            <div className="sm:col-span-2 flex justify-end">
              <div className="grid w-full max-w-[320px] grid-cols-4 gap-2">
                {QUICK_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    onClick={() => applyQuickFilter(filter.daysBack)}
                    className={`min-w-0 rounded-full border px-2 py-1.5 text-[9px] font-black uppercase tracking-[0.14em] transition-all dashboard-secondary-box dashboard-filter-btn ${
                      activeQuickFilter === filter.id
                        ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.12)]'
                        : 'border-cyan-800/50 bg-[#0b1229]/70 text-cyan-500 hover:border-cyan-600 hover:text-cyan-300'
                    }`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-cyan-300/70">
          <span className="rounded-full border border-cyan-800/60 bg-[#0b1229]/70 px-3 py-1.5 dashboard-secondary-box dashboard-info-badge">
            Periode: {formatDateKey(startDate)} - {formatDateKey(endDate)}
          </span>
          <span className="rounded-full border border-cyan-800/60 bg-[#0b1229]/70 px-3 py-1.5 dashboard-secondary-box dashboard-info-badge">
            Entry patroli: {filteredEntries.length}
          </span>
          <span className="rounded-full border border-cyan-800/60 bg-[#0b1229]/70 px-3 py-1.5 dashboard-secondary-box dashboard-info-badge">
            Kapal terdeteksi: {perShipBreakdown.length}
          </span>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Total Completion Rate"
          value={`${formatMetricNumber(completionRate, 1)}%`}
          subtitle={`${dashboardMetrics.completed}/${dashboardMetrics.total} checkpoint selesai`}
          accentClass="text-emerald-300"
          icon={<Activity className="h-5 w-5 text-emerald-300" />}
        >
          <div className="h-2 overflow-hidden rounded-full border border-emerald-500/20 bg-emerald-950/20">
            <div
              className={`h-full rounded-full bg-gradient-to-r ${getProgressTone(completionRate)}`}
              style={{ width: `${Math.max(completionRate, 4)}%` }}
            ></div>
          </div>
        </MetricCard>

        <MetricCard
          title="Total Aman"
          value={formatMetricNumber(dashboardMetrics.aman)}
          subtitle="Checkpoint selesai dengan status aman"
          accentClass="text-cyan-300"
          icon={<CheckCircle2 className="h-5 w-5 text-cyan-300" />}
        />

        <MetricCard
          title="Total Missed"
          value={formatMetricNumber(dashboardMetrics.missed)}
          subtitle="Checkpoint yang tidak dipatroli pada periode ini"
          accentClass="text-rose-300"
          icon={<CircleOff className="h-5 w-5 text-rose-300" />}
        />

        <MetricCard
          title="Total Temuan"
          value={formatMetricNumber(dashboardMetrics.temuan)}
          subtitle={`${openIncidents.length} temuan masih OPEN`}
          accentClass="text-yellow-300"
          icon={<AlertTriangle className="h-5 w-5 text-yellow-300" />}
        />
      </section>

      <section className="min-w-0 rounded-[1.9rem] border border-cyan-800/50 bg-[#0b1229] p-5 shadow-[0_0_24px_rgba(8,145,178,0.08)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-500">View Chart</p>
            <h3 className="mt-2 text-xl font-black text-white">Completion Rate, Aman, Temuan, Missed</h3>
          </div>
          <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-cyan-300">
            <BarChart3 className="h-5 w-5" />
          </div>
        </div>

        {chartData.length === 0 ? (
          <div className="mt-5">
            <EmptyState
              title="Belum Ada Data Harian"
              description="Silakan pilih rentang tanggal yang memiliki entry patroli."
              icon={<BarChart3 className="h-5 w-5" />}
            />
          </div>
        ) : (
          <SectionErrorBoundary
            fallback={(
              <div className="mt-5">
                <EmptyState
                  title="Chart Tidak Tersedia"
                  description="Grafik sementara tidak bisa dirender, tetapi data report lainnya tetap aman tampil."
                  icon={<BarChart3 className="h-5 w-5" />}
                />
              </div>
            )}
          >
            <DailyReportTrendChart chartData={chartData} />
          </SectionErrorBoundary>
        )}
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="min-w-0 rounded-[1.9rem] border border-cyan-800/50 bg-[#0b1229] p-5 shadow-[0_0_24px_rgba(8,145,178,0.08)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-500">Dashboard Utama</p>
              <h3 className="mt-2 text-xl font-black text-white">Breakdown Per Kapal</h3>
            </div>
            <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-cyan-300">
              <Anchor className="h-5 w-5" />
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {perShipBreakdown.length === 0 ? (
              <div>
                <EmptyState
                  title="Belum Ada Ringkasan Kapal"
                  description="Tidak ada entry patroli dalam rentang tanggal yang dipilih."
                  icon={<Anchor className="h-5 w-5" />}
                />
              </div>
            ) : perShipBreakdown.map((ship) => (
              <div key={ship.ship} className="rounded-[1.4rem] border border-cyan-800/50 bg-[#070b19] p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div
                    className="min-w-0 flex-1"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-lg font-black text-white">{ship.ship}</p>
                        <p className="mt-1 text-[11px] uppercase tracking-widest text-cyan-500">
                          {ship.shifts} shift tercatat
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${
                        ship.completionRate >= 90
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : ship.completionRate >= 70
                            ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                            : 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300'
                      }`}>
                        {formatMetricNumber(ship.completionRate, 1)}%
                      </span>
                    </div>

                    <div className="mt-4 h-2 overflow-hidden rounded-full border border-cyan-900/50 bg-[#0b1229]">
                      <div
                        className={`h-full rounded-full bg-gradient-to-r ${getProgressTone(ship.completionRate)}`}
                        style={{ width: `${Math.max(ship.completionRate, 4)}%` }}
                      ></div>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-2 lg:min-w-[252px]">
                    <div
                      title="Completion Rate"
                      className="flex flex-col items-center justify-center rounded-xl border border-cyan-900/40 bg-[#0b1229] px-2 py-3 text-cyan-300"
                    >
                      <Activity className="h-4 w-4" />
                      <p className="mt-2 text-sm font-black text-cyan-100">{formatMetricNumber(ship.completionRate, 1)}%</p>
                    </div>
                    <div
                      title="Aman"
                      className="flex flex-col items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-2 py-3 text-emerald-300"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <p className="mt-2 text-sm font-black text-emerald-200">{Math.max(ship.completed - ship.temuan, 0)}</p>
                    </div>
                    <div
                      title="Temuan"
                      className="flex flex-col items-center justify-center rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-2 py-3 text-yellow-300"
                    >
                      <CircleAlert className="h-4 w-4" />
                      <p className="mt-2 text-sm font-black text-yellow-200">{ship.temuan}</p>
                    </div>
                    <div
                      title="Missed"
                      className="flex flex-col items-center justify-center rounded-xl border border-rose-500/20 bg-rose-500/10 px-2 py-3 text-rose-300"
                    >
                      <CircleOff className="h-4 w-4" />
                      <p className="mt-2 text-sm font-black text-rose-200">{ship.missed}</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="min-w-0 rounded-[1.9rem] border border-cyan-800/50 bg-[#0b1229] p-5 shadow-[0_0_24px_rgba(8,145,178,0.08)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-500">Aktivitas Petugas</p>
              <h3 className="mt-2 text-xl font-black text-white">5 Petugas Patroli Terakhir</h3>
            </div>
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-emerald-300">
              <UserRound className="h-5 w-5" />
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {latestGuardPatrols.length === 0 ? (
              <EmptyState
                title="Belum Ada Aktivitas"
                description="Belum ada checkpoint selesai pada periode tanggal ini."
                icon={<UserRound className="h-5 w-5" />}
              />
            ) : latestGuardPatrols.map((guard, index) => (
              <div key={guard.id} className="flex items-center gap-3 rounded-[1.25rem] border border-cyan-800/50 bg-[#070b19] p-3">
                <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-cyan-700/50 bg-[#0b1229] text-cyan-400">
                  {guard.photoUrl ? (
                    <AsyncImage
                      src={guard.photoUrl}
                      alt={guard.name}
                      className="h-full w-full object-cover"
                      fallbackLayout={<UserRound className="h-5 w-5" />}
                    />
                  ) : (
                    <UserRound className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-black text-white">{guard.name}</p>
                  </div>
                  <p className="mt-1 truncate text-xs text-cyan-300/75 latest-guard-subtext">{guard.ship} - {guard.checkpoint}</p>
                </div>
                <div className="rounded-xl border border-cyan-800/50 bg-[#0b1229] px-3 py-2 text-right">
                  <p className="text-[10px] font-black uppercase tracking-widest text-cyan-500">Jam</p>
                  <p className="mt-1 text-xs font-bold text-cyan-100">{formatDateTime(guard.completedAt)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="min-w-0 rounded-[1.9rem] border border-cyan-800/50 bg-[#0b1229] p-5 shadow-[0_0_24px_rgba(8,145,178,0.08)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-500">Dashboard Temuan</p>
              <h3 className="mt-2 text-xl font-black text-white">Status OPEN dan Update Terakhir</h3>
            </div>
            <div className="flex items-center gap-2 rounded-2xl border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-yellow-300">
              <ShieldAlert className="h-5 w-5" />
              <span className="text-lg font-black leading-none">
                {formatMetricNumber(openIncidents.length)}
              </span>
            </div>
          </div>

          <div className="mt-4 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 scrollbar-none [&::-webkit-scrollbar]:hidden">
            {openIncidents.length === 0 ? (
              <div className="w-full shrink-0 snap-center">
                <EmptyState
                  title="Tidak Ada Temuan Open"
                  description="Semua temuan pada rentang tanggal ini sudah closed atau belum ada temuan yang masuk."
                  icon={<CheckCircle2 className="h-5 w-5" />}
                />
              </div>
            ) : openIncidents.map((incident) => (
              <button
                key={incident.id}
                id={`incident-card-${incident.id}`}
                type="button"
                onClick={() => openIncidentDetail(incident)}
                className="w-full shrink-0 snap-center rounded-[1.35rem] border border-yellow-500/20 bg-[#070b19] p-4 text-left transition-all hover:border-yellow-400/40 hover:bg-[#0b1229] hover:shadow-[0_0_24px_rgba(250,204,21,0.08)]"
              >
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_9rem]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-yellow-300">
                        OPEN
                      </span>
                      <span className="rounded-full border border-cyan-800/60 bg-[#0b1229] px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-cyan-400">
                        {incident.shipName || '-'}
                      </span>
                      <span className="rounded-full border border-cyan-800/60 bg-[#0b1229] px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-cyan-500">
                        {incident.isPatrol ? 'Patroli' : 'Manual'}
                      </span>
                    </div>

                    <h4 className="mt-3 text-lg font-black text-white">{incident.location || 'Lokasi temuan'}</h4>
                    <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-cyan-100/75">
                      {incident.deskripsi || incident.tindakLanjut || 'Belum ada deskripsi tambahan.'}
                    </p>
                  </div>

                  {incident.photoUrl ? (
                    <div className="w-full xl:w-36">
                      <div className="overflow-hidden rounded-[1.2rem] border border-yellow-500/20 bg-[#0b1229]">
                        <AsyncImage
                          src={incident.heroUrl}
                          fallbackSrc={incident.photoUrl}
                          alt={incident.location}
                          className="h-32 w-full object-cover xl:h-36"
                          fallbackLayout={<div className="flex h-32 w-full items-center justify-center text-cyan-700 xl:h-36"><CircleAlert className="h-6 w-6" /></div>}
                        />
                      </div>
                    </div>
                  ) : null}

                  <div className={`grid grid-cols-1 gap-3 md:grid-cols-2 ${incident.photoUrl ? 'xl:col-span-2' : ''}`}>
                    <div className="rounded-xl border border-cyan-900/40 bg-[#0b1229] p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-cyan-500">Update Terakhir</p>
                      <p className="mt-2 text-sm font-bold text-cyan-100 incident-card-subtext">{incident.lastUpdateTime}</p>
                      <p className="mt-2 text-xs leading-relaxed text-cyan-300/75 incident-card-subtext">{incident.lastUpdateLabel}</p>
                    </div>
                    <div className="rounded-xl border border-cyan-900/40 bg-[#0b1229] p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-cyan-500">Pelapor dan Progress</p>
                      <p className="mt-2 text-sm font-bold text-cyan-100 incident-card-subtext">{incident.reportedBy || '-'}</p>
                      <p className="mt-2 text-xs text-cyan-300/75 incident-card-subtext">{incident.progressCount} update progres tercatat</p>
                      <p className="mt-1 text-xs text-cyan-500/75 incident-card-subtext">Dibuat: {incident.createdLabel}</p>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {openIncidents.length > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {openIncidents.map((incident, index) => (
                <button
                  key={`nav-${incident.id}`}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const el = document.getElementById(`incident-card-${incident.id}`);
                    if (el) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
                    }
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-800/50 bg-[#0b1229] text-xs font-black text-cyan-500 transition-all hover:border-cyan-400 hover:bg-cyan-500/10 hover:shadow-[0_0_12px_rgba(6,182,212,0.15)] focus:outline-none"
                  aria-label={`Scroll ke temuan ${index + 1}`}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="rounded-[1.9rem] border border-cyan-800/50 bg-[#0b1229] p-5 shadow-[0_0_24px_rgba(8,145,178,0.08)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-500">Emergency Info</p>
                <h3 className="mt-2 text-xl font-black text-white">Info SOS</h3>
              </div>
              <div className="flex items-center gap-2 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-rose-300">
                <ShieldAlert className="h-5 w-5" />
                <span className="text-lg font-black leading-none">
                  {formatMetricNumber(sosInfoEntries.length)}
                </span>
              </div>
            </div>

            <div className="mt-5 max-h-[380px] space-y-3 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-rose-900/40">
              {sosInfoEntries.length === 0 ? (
                <EmptyState
                  title="Tidak Ada SOS"
                  description="Belum ada aktivitas tombol SOS pada periode laporan ini."
                  icon={<ShieldAlert className="h-5 w-5" />}
                />
              ) : sosInfoEntries.map((item) => {
                const triggeredDate = item.triggeredAt ? new Date(item.triggeredAt) : null;
                const timeLabel = triggeredDate && !Number.isNaN(triggeredDate.getTime())
                  ? triggeredDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: APP_TIME_ZONE })
                  : '-';
                const dateLabel = triggeredDate && !Number.isNaN(triggeredDate.getTime())
                  ? triggeredDate.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: APP_TIME_ZONE })
                  : '-';

                return (
                  <div key={item.id} className="rounded-[1.2rem] border border-rose-500/20 bg-rose-500/10 px-4 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-white">{item.shipName}</p>
                        <p className="mt-1 truncate text-xs text-cyan-300/80">{item.senderName}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-black text-rose-200">{timeLabel}</p>
                        <p className="mt-1 text-[11px] text-cyan-300/70 sos-card-date">{dateLabel}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
});

export default DailyReportPage;
