import type { Report } from '../../src/report.js';

const percent = (x: number): string => `${Math.round(x * 100)}%`;

export function ReportTable({ report }: { report: Report }) {
  const names = report.strategies.map((s) => s.name);
  if (report.ads.length === 0) {
    return <p>No views stored yet for tenant {report.tenant}.</p>;
  }
  const totalViews = report.ads.reduce((n, ad) => n + ad.views, 0);
  const total = (name: string): number => report.ads.reduce((n, ad) => n + (ad.counted[name] ?? 0), 0);
  return (
    <>
      <table>
        <caption>Counted impressions per ad, tenant {report.tenant}</caption>
        <thead>
          <tr>
            <th scope="col">Ad</th>
            <th scope="col" className="num">
              Views
            </th>
            {names.map((name) => (
              <th key={name} scope="col" className="num">
                Counted, {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.ads.map((ad) => (
            <tr key={ad.adId}>
              <th scope="row">{ad.adId}</th>
              <td className="num">{ad.views}</td>
              {names.map((name) => (
                <td key={name} className="num">
                  {ad.counted[name] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">All ads</th>
            <td className="num">{totalViews}</td>
            {names.map((name) => (
              <td key={name} className="num">
                {total(name)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      <ul className="rules">
        {report.strategies.map((s) => (
          <li key={s.name}>
            <strong>{s.name}</strong>: counted when at least {percent(s.threshold)} of the ad is in view for{' '}
            {s.minVisibleMs} ms in a row, with the clock starting at the {s.timerStart === 'first-token' ? 'first token' : 'last token'}.
          </li>
        ))}
      </ul>
    </>
  );
}
