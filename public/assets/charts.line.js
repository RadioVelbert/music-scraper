import {
  appendChartStats,
  bindChartTooltip,
  buildNiceYAxis,
  chartWidth,
  drawAxes,
  drawAxisLabels,
  drawXAxisTicks,
  drawYAxisGrid,
  downsampleSeries,
  formatPlays,
  formatSeriesPeriod,
  getChartColors,
  makeSvg,
  makeSvgEl,
  renderChartEmpty
} from './charts.base.js';

export function renderLineChart(container, series, bucket = 'day', options = {}) {
  container.innerHTML = '';
  const rows = downsampleSeries(series || [], options.maxPoints || 220);
  if (!rows.length) {
    renderChartEmpty(container, 'Keine Daten im Zeitraum.');
    return;
  }

  appendChartStats(container, options.stats);

  const height = 260;
  const pad = { t: 18, r: 36, b: 50, l: 60 };
  const width = chartWidth(container, rows.length * 26 + pad.l + pad.r, 420);
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const maxY = Math.max(...rows.map((s) => Number(s.plays || 0)), 1);
  const yAxis = buildNiceYAxis(maxY, 4);
  const step = rows.length > 1 ? w / (rows.length - 1) : 0;
  const svg = makeSvg(width, height);
  const colors = getChartColors(container);
  const pointColor = options.color || colors.primary;

  drawAxes(svg, pad, w, h, colors);
  drawYAxisGrid(svg, pad, w, h, yAxis, colors);
  drawXAxisTicks(svg, pad, w, h, rows, bucket, 6, colors);
  drawAxisLabels(svg, pad, w, h, width, height, 'Zeitraum', 'Einsätze');

  let d = '';
  const points = [];
  rows.forEach((p, i) => {
    const x = rows.length > 1 ? pad.l + i * step : pad.l + w / 2;
    const y = pad.t + h - (Number(p.plays || 0) / yAxis.maxTick) * h;
    points.push({ x, y, period: p.period, plays: Number(p.plays || 0) });
    d += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
  });

  if (options.showArea && points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    svg.appendChild(makeSvgEl('path', {
      d: `${d.trim()} L ${last.x} ${pad.t + h} L ${first.x} ${pad.t + h} Z`,
      fill: colors.primaryFill,
      stroke: 'none'
    }));
  }

  svg.appendChild(makeSvgEl('path', {
    d: d.trim(),
    fill: 'none',
    stroke: pointColor,
    'stroke-width': 2.3
  }));

  points.forEach((p) => {
    const hit = makeSvgEl('circle', { cx: p.x, cy: p.y, r: 10, fill: 'transparent' });
    const dot = makeSvgEl('circle', { cx: p.x, cy: p.y, r: 3.8, fill: pointColor });
    svg.appendChild(hit);
    svg.appendChild(dot);
    bindChartTooltip(container, hit, () => `${formatSeriesPeriod(p.period, bucket)}: ${formatPlays(p.plays)} Einsätze`);
  });

  const last = points[points.length - 1];
  if (last) {
    const label = makeSvgEl('text', {
      x: Math.min(last.x + 8, pad.l + w - 8),
      y: Math.max(pad.t + 12, last.y - 8),
      'font-size': 11,
      'text-anchor': 'start'
    });
    label.textContent = formatPlays(last.plays);
    svg.appendChild(label);
  }

  container.appendChild(svg);

  if ((series || []).length > rows.length) {
    const note = document.createElement('div');
    note.className = 'chart-note';
    note.textContent = `Angezeigt: ${rows.length} von ${series.length} Punkten (für bessere Lesbarkeit).`;
    container.appendChild(note);
  }
}
