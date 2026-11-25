// Seed configuration. Edit here or via the dashboard (changes are stored in KV and take precedence).

export const DEFAULT_BASKET = [
  { symbol: 'AAPL' },
  { symbol: 'MSFT' },
  { symbol: 'NVDA' },
  { symbol: 'AMZN' },
  { symbol: 'GOOGL' },
  { symbol: 'META' },
  { symbol: 'AVGO' },
  { symbol: 'TSLA' },
  { symbol: 'JPM' },
  { symbol: 'LLY' },
  { symbol: 'XOM' },
  { symbol: 'SPY', type: 'etf' },
  { symbol: 'QQQ', type: 'etf' },
  { symbol: 'DIA', type: 'etf' },
];

// Market-informing dates (closing prices are used; non-trading days roll back to the prior close)
export const DEFAULT_EVENTS = [
  { date: '2020-02-19', label: 'Pre-COVID peak' },
  { date: '2020-03-23', label: 'COVID low' },
  { date: '2022-01-03', label: '2022 peak' },
  { date: '2022-10-12', label: '2022 bear low' },
  { date: '2025-02-19', label: 'Pre-tariff peak' },
  { date: '2025-04-08', label: 'Tariff low' },
];
