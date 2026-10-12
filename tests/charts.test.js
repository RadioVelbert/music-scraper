import { describe, expect, it } from 'vitest';
import { fixReversedNames, parseRadiocharts } from '../src/charts.js';

const row = (pos, prev, trend, title, artist, label = 'Label') => `
<tr>
<td align="center" title="Trend"><img src="/images/trend_${trend}.gif" alt="+"></img></td>
<td align="right" title="Chart-Position in der aktuell angezeigten Chartwoche"><strong>${pos}</strong></td>
<td align="right" title="Chart-Position in der Vorwoche">   ${prev}</td>
<td align="right" title="Höchste Chart-Position">1</td>
<td align="left" title="Titel">${title}</td>
<td align="left" title="Interpret">${artist}</td>
<td align="left" title="Label">${label}</td>
<td align="right" title="Anzahl der Wochen in den TOP100 Charts">9</td>
</tr>`;

const HTML = `<html><body><h4>Chartwoche 40/2026</h4>
<table class="chartTable"><thead><tr><th>P</th></tr></thead><tbody>
${row(1, 2, 'up', 'Animal', 'Katseye')}
${row(2, '', 'new', 'Take It Slow', 'Schulz, Robin x Watermät')}
${row(3, 1, 'down', 'Komm näher', 'Juju x RAF Camora')}
</tbody></table></body></html>`;

describe('radiocharts parser', () => {
  it('reads week, positions, movement and fixes reversed names', () => {
    const result = parseRadiocharts(HTML);
    expect(result.week).toBe('2026-W40');
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toMatchObject({ position: 1, prev_position: 2, peak_position: 1, weeks: 9, trend: 'up', title: 'Animal', artist: 'Katseye' });
    expect(result.entries[1]).toMatchObject({ prev_position: null, trend: 'new', artist: 'Robin Schulz x Watermät' });
    expect(result.entries[2]).toMatchObject({ trend: 'down', title: 'Komm näher' });
  });

  it('keeps real comma band names', () => {
    expect(fixReversedNames('Earth, Wind & Fire')).toBe('Earth, Wind & Fire');
    expect(fixReversedNames('Guetta, David & Sia')).toBe('David Guetta & Sia');
  });

  it('fails loudly when the page layout changes', () => {
    expect(() => parseRadiocharts('<html><h4>Chartwoche 40/2026</h4></html>')).toThrow('Keine Chart-Einträge');
    expect(() => parseRadiocharts('<html></html>')).toThrow('Chartwoche');
  });
});

describe('Billboard parser', () => {
  const li = (value, extra = '') => `<li class="o-chart-results-list__item ${extra}"><span class="c-label">${value}</span></li>`;
  const bbRow = (pos, title, artist, lw, peak, weeks) => `
    <div class="o-chart-results-list-row-container"><ul class="o-chart-results-list-row">
      <li class="o-chart-results-list__item"><span class="c-label">${pos}</span></li>
      <li><img data-lazy-src="https://charts-static.billboard.com/img/${pos}.jpg" src="https://www.billboard.com/lazyload-fallback.gif"></li>
      <li class="o-chart-results-list__item"><h3 id="title-of-a-story">${title}</h3><span class="c-label">${artist}</span></li>
      <li class="lrv-u-flex"><span>LW</span></li>${li(lw)}${li(peak)}${li(weeks)}
    </ul></div>`;
  const page = `<html><body><p>Week of October 10, 2026</p>
    ${bbRow(1, 'The Life Of A Showgirl', 'Taylor Swift', '21', '1', '52')}
    ${bbRow(6, 'POPSTAR', 'Tinashe', '-', '6', '1')}</body></html>`;

  it('reads albums, movement and cover images', async () => {
    const { parseBillboard } = await import('../src/charts.js');
    const result = parseBillboard(page);
    expect(result.week).toBe('2026-W41');
    expect(result.entries[0]).toMatchObject({
      position: 1, title: 'The Life Of A Showgirl', artist: 'Taylor Swift', prev_position: 21, peak_position: 1, weeks: 52, trend: 'up',
      image_url: 'https://charts-static.billboard.com/img/1.jpg'
    });
    expect(result.entries[1]).toMatchObject({ prev_position: null, trend: 'new', weeks: 1 });
  });
});
