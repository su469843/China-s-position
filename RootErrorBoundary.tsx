import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {reportError} from './errorReporting';

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
};

class RootErrorBoundary extends React.Component<Props, State> {
  state: State = {
    hasError: false,
  };

  static getDerivedStateFromError() {
    return {hasError: true};
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError(error, {
      fatal: true,
      source: 'react-error-boundary',
      extra: {
        componentStack: info.componentStack,
      },
    });
  }

  handleReload = () => {
    this.setState({hasError: false});
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>应用遇到了一点问题</Text>
          <Text style={styles.description}>
            错误已经尝试上报到云端，你可以重新打开页面继续使用。
          </Text>
          <Pressable style={styles.button} onPress={this.handleReload}>
            <Text style={styles.buttonText}>重试</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#eef6ff',
  },
  title: {
    color: '#0f172a',
    fontSize: 22,
    fontWeight: '800',
  },
  description: {
    marginTop: 12,
    color: '#334155',
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  button: {
    marginTop: 18,
    borderRadius: 12,
    backgroundColor: '#2563eb',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
});

export default RootErrorBoundary;
