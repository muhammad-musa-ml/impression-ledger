import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Report } from '../src/report.js';
import { defaultStrategies } from '../src/viewability.js';
import { ReportTable } from '../web/src/ReportTable.js';

const report: Report = {
  tenant: 'alpha',
  strategies: defaultStrategies(),
  ads: [
    { adId: 'ad-01', views: 40, counted: { 'first-token': 31, 'fully-rendered': 22 } },
    { adId: 'ad-02', views: 12, counted: { 'first-token': 5, 'fully-rendered': 5 } },
  ],
};

describe('report table', () => {
  it('shows one row per ad with the count under each strategy, and the totals', () => {
    const html = renderToStaticMarkup(<ReportTable report={report} />);
    expect(html).toContain('ad-01');
    expect(html).toMatch(/ad-01<\/th><td class="num">40<\/td><td class="num">31<\/td><td class="num">22<\/td>/);
    expect(html).toMatch(/All ads<\/th><td class="num">52<\/td><td class="num">36<\/td><td class="num">27<\/td>/);
    expect(html).toContain('Counted, first-token');
    expect(html).toContain('Counted, fully-rendered');
  });

  it('states each rule in words', () => {
    const html = renderToStaticMarkup(<ReportTable report={report} />);
    expect(html).toContain('at least 50% of the ad is in view');
    expect(html).toContain('1000 ms in a row');
  });

  it('says so when nothing has been stored', () => {
    const html = renderToStaticMarkup(<ReportTable report={{ ...report, ads: [] }} />);
    expect(html).toContain('No views stored yet for tenant');
    expect(html).not.toContain('<table');
  });
});
