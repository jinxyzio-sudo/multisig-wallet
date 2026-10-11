import type { Finding, Report } from './analyze.js';

type Child = Node | string | null | undefined | false;

/** Tiny DOM builder. Text is always set via text nodes: chain data (coin symbols, types) is untrusted. */
export function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

export function formatSui(mist: bigint): string {
  const negative = mist < 0n;
  const abs = negative ? -mist : mist;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''} SUI`;
}

export function hasDanger(report: Report): boolean {
  return report.findings.some((f) => f.level === 'danger');
}

function findingRow(f: Finding): HTMLElement {
  const icon = f.level === 'danger' ? '⛔' : f.level === 'warn' ? '⚠️' : 'ℹ️';
  return h('li', { class: `finding ${f.level}` }, `${icon} ${f.text}`);
}

export function renderReport(report: Report): HTMLElement {
  const danger = report.findings.filter((f) => f.level === 'danger');
  const rest = report.findings.filter((f) => f.level !== 'danger');

  const self =
    report.selfChanges.length === 0
      ? h('p', { class: 'muted' }, 'No coin balance change for the multisig')
      : h(
          'ul',
          { class: 'amounts' },
          ...report.selfChanges.map((c) =>
            h('li', { class: c.raw < 0n ? 'out' : 'in' }, `${c.raw > 0n ? '+' : ''}${c.formatted} ${c.symbol}`),
          ),
        );

  return h(
    'section',
    { class: 'report' },
    h('div', { class: `verdict ${danger.length ? 'danger' : report.simulationOk ? 'ok' : 'danger'}` },
      danger.length
        ? `${danger.length} thing(s) need your attention`
        : report.simulationOk
          ? 'Simulation OK. Nothing leaves the multisig except what is listed below.'
          : 'Simulation failed'),
    danger.length ? h('ul', { class: 'findings' }, ...danger.map(findingRow)) : null,
    h('h3', {}, 'Multisig balance change'),
    self,
    h('h3', {}, 'Calls'),
    report.calls.length
      ? h('ul', { class: 'calls' }, ...report.calls.map((c) => h('li', {}, h('code', {}, c.target), c.label ? ` — ${c.label}` : ' — unknown package')))
      : h('p', { class: 'muted' }, 'No Move calls'),
    rest.length ? h('ul', { class: 'findings' }, ...rest.map(findingRow)) : null,
    h('p', { class: 'muted small' },
      `Gas budget ${formatSui(report.gasBudgetMist)}`,
      report.gasCostMist !== null ? ` · estimated cost ${formatSui(report.gasCostMist)}` : ''),
  );
}
