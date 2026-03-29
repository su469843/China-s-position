/* eslint-env jest */

global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
  }),
);

global.ErrorUtils = {
  getGlobalHandler: jest.fn(() => undefined),
  setGlobalHandler: jest.fn(),
};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));

jest.mock('react-native-geolocation-service', () => ({
  requestAuthorization: jest.fn(() => Promise.resolve('granted')),
  getCurrentPosition: jest.fn((_success, error) => {
    if (error) {
      error({message: 'mock geolocation not available in test'});
    }
  }),
}));

jest.mock('react-native-maps', () => {
  const React = require('react');
  const {View} = require('react-native');

  const MockMapView = ({children}) => React.createElement(View, null, children);
  const MockMarker = ({children}) => React.createElement(View, null, children);
  const MockPolyline = () => React.createElement(View, null);

  return {
    __esModule: true,
    default: MockMapView,
    Marker: MockMarker,
    Polyline: MockPolyline,
  };
});
