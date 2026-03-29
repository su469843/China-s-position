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

jest.mock('@maplibre/maplibre-react-native', () => {
  const React = require('react');
  const {View} = require('react-native');

  const MockMapView = ({children}) => React.createElement(View, null, children);
  const MockCamera = () => React.createElement(View, null);
  const MockPointAnnotation = ({children}) => React.createElement(View, null, children);
  const MockShapeSource = ({children}) => React.createElement(View, null, children);
  const MockLineLayer = () => React.createElement(View, null);
  const MockUserLocation = () => React.createElement(View, null);

  return {
    __esModule: true,
    MapView: MockMapView,
    Camera: MockCamera,
    PointAnnotation: MockPointAnnotation,
    ShapeSource: MockShapeSource,
    LineLayer: MockLineLayer,
    UserLocation: MockUserLocation,
  };
});
