import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState, Platform} from 'react-native';

import {APP_VERSION, ERROR_REPORTING_URL} from './appConfig';

type ErrorContext = {
  fatal?: boolean;
  source?: string;
  extra?: Record<string, unknown>;
};

type ErrorUtilsShape = {
  getGlobalHandler?: () => ((error: Error, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
};

type SessionMarker = {
  appVersion: string;
  sessionId: string;
  state: 'active' | 'background';
  timestamp: string;
};

const getErrorUtils = (): ErrorUtilsShape | undefined => {
  return (globalThis as typeof globalThis & {ErrorUtils?: ErrorUtilsShape}).ErrorUtils;
};

const normalizeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (typeof error === 'string') {
    return {
      name: 'Error',
      message: error,
      stack: undefined,
    };
  }

  return {
    name: 'UnknownError',
    message: 'Unknown error',
    stack: undefined,
  };
};

export const isErrorReportingEnabled = () => ERROR_REPORTING_URL.trim().length > 0;

export async function reportError(error: unknown, context: ErrorContext = {}) {
  if (!isErrorReportingEnabled()) {
    return;
  }

  const normalized = normalizeError(error);

  try {
    await fetch(ERROR_REPORTING_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appVersion: APP_VERSION,
        platform: Platform.OS,
        timestamp: new Date().toISOString(),
        error: normalized,
        context: {
          fatal: context.fatal ?? false,
          source: context.source ?? 'unknown',
          extra: context.extra ?? {},
        },
      }),
    });
  } catch (reportingError) {
    console.warn('Error reporting upload failed', reportingError);
  }
}

let hasInstalledGlobalHandler = false;
let hasInstalledSessionTracking = false;
let currentSessionId = '';

const SESSION_MARKER_STORAGE_KEY = 'error_reporting_session_marker_v1';

const buildSessionMarker = (state: SessionMarker['state']): SessionMarker => ({
  appVersion: APP_VERSION,
  sessionId: currentSessionId,
  state,
  timestamp: new Date().toISOString(),
});

const persistSessionMarker = async (state: SessionMarker['state']) => {
  if (!currentSessionId) {
    return;
  }

  try {
    await AsyncStorage.setItem(
      SESSION_MARKER_STORAGE_KEY,
      JSON.stringify(buildSessionMarker(state)),
    );
  } catch (error) {
    console.warn('Session marker write failed', error);
  }
};

const installSessionTracking = () => {
  if (hasInstalledSessionTracking) {
    return;
  }

  hasInstalledSessionTracking = true;
  currentSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  void (async () => {
    try {
      const previousMarkerRaw = await AsyncStorage.getItem(SESSION_MARKER_STORAGE_KEY);
      if (previousMarkerRaw) {
        const previousMarker = JSON.parse(previousMarkerRaw) as Partial<SessionMarker>;
        if (
          previousMarker.state === 'active' &&
          typeof previousMarker.sessionId === 'string' &&
          previousMarker.sessionId !== currentSessionId
        ) {
          await reportError(new Error('Possible abnormal exit detected on previous launch'), {
            fatal: true,
            source: 'previous-session-marker',
            extra: previousMarker,
          });
        }
      }
    } catch (error) {
      console.warn('Session marker read failed', error);
    }

    await persistSessionMarker('active');
  })();

  AppState.addEventListener('change', nextState => {
    void persistSessionMarker(nextState === 'active' ? 'active' : 'background');
  });
};

export function installGlobalErrorHandlers() {
  if (hasInstalledGlobalHandler) {
    return;
  }

  hasInstalledGlobalHandler = true;
  installSessionTracking();

  const errorUtils = getErrorUtils();
  const previousHandler = errorUtils?.getGlobalHandler?.();

  errorUtils?.setGlobalHandler?.((error, isFatal) => {
    reportError(error, {
      fatal: Boolean(isFatal),
      source: 'global-js-handler',
    });

    if (previousHandler) {
      previousHandler(error, isFatal);
    }
  });
}
