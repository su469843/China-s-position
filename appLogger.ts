type AppLogLevel = 'info' | 'warn' | 'error';

export type AppLogEntry = {
  id: string;
  timestamp: string;
  level: AppLogLevel;
  source: string;
  message: string;
  details?: Record<string, unknown>;
};

type AppLogPayload = {
  level?: AppLogLevel;
  source: string;
  message: string;
  details?: Record<string, unknown>;
};

type AppLogListener = (entries: AppLogEntry[]) => void;

const MAX_LOG_ENTRIES = 200;

let entries: AppLogEntry[] = [];

const listeners = new Set<AppLogListener>();

const notifyListeners = () => {
  const snapshot = [...entries];
  listeners.forEach(listener => listener(snapshot));
};

const safeJsonStringify = (value: Record<string, unknown>) => {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable-details]';
  }
};

export const appendAppLog = ({level = 'info', source, message, details}: AppLogPayload) => {
  entries = [
    ...entries,
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      details,
    },
  ].slice(-MAX_LOG_ENTRIES);

  notifyListeners();
};

export const getAppLogs = () => [...entries];

export const subscribeAppLogs = (listener: AppLogListener) => {
  listeners.add(listener);
  listener(getAppLogs());

  return () => {
    listeners.delete(listener);
  };
};

export const formatAppLogsForDisplay = (logEntries = entries) =>
  logEntries
    .map(entry => {
      const detailText = entry.details ? ` | ${safeJsonStringify(entry.details)}` : '';
      return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}${detailText}`;
    })
    .join('\n');

appendAppLog({
  source: 'app-logger',
  message: '应用日志系统已初始化',
});
