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
