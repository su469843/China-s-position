/**
 * @format
 */

import React from 'react';
import { AppRegistry } from 'react-native';
import App from './App';
import RootErrorBoundary from './RootErrorBoundary';
import {installGlobalErrorHandlers} from './errorReporting';
import { name as appName } from './app.json';

installGlobalErrorHandlers();

function RootApp() {
  return (
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  );
}

AppRegistry.registerComponent(appName, () => RootApp);
