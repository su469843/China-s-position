import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  Linking,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView as LegacySafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {appendAppLog, formatAppLogsForDisplay, subscribeAppLogs} from './appLogger';
import {APP_VERSION} from './appConfig';
import {reportError} from './errorReporting';

type Coordinate = {
  latitude: number;
  longitude: number;
};

type SavedPoint = Coordinate & {
  id: string;
  name: string;
};

const DEFAULT_TARGET: Coordinate = {
  latitude: 39.9042,
  longitude: 116.4074,
};

const STORAGE_KEY = 'saved_grave_points_v1';
const OPEN_FREE_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const TITLE_DOUBLE_TAP_WINDOW_MS = 350;
const TITLE_SEQUENCE_WINDOW_MS = 1800;
const DEBUG_PULL_DISTANCE = 36;
const DEBUG_PULL_TARGET = 3;
const ROUTE_LINE_STYLE = {
  lineColor: '#ef4444',
  lineWidth: 4,
  lineOpacity: 0.85,
};

type GeolocationModule = {
  requestAuthorization?: (mode: 'whenInUse' | 'always') => Promise<string>;
  getCurrentPosition: (
    success: (position: {coords: Coordinate}) => void,
    error?: (error: {code: number; message: string}) => void,
    options?: {
      enableHighAccuracy?: boolean;
      timeout?: number;
      maximumAge?: number;
    },
  ) => void;
};

type MapsModule = {
  MapView: React.ComponentType<any>;
  Camera: React.ComponentType<any>;
  PointAnnotation: React.ComponentType<any>;
  ShapeSource: React.ComponentType<any>;
  LineLayer: React.ComponentType<any>;
  UserLocation: React.ComponentType<any>;
};

let cachedGeolocationModule: GeolocationModule | null | undefined;
let cachedMapsModule: MapsModule | null | undefined;
let cachedSafeAreaViewComponent: React.ComponentType<any> | undefined;

const loadGeolocationModule = (): GeolocationModule | null => {
  if (cachedGeolocationModule !== undefined) {
    return cachedGeolocationModule;
  }

  try {
    cachedGeolocationModule = require('react-native-geolocation-service') as GeolocationModule;
    return cachedGeolocationModule;
  } catch (error) {
    cachedGeolocationModule = null;
    reportError(error, {
      source: 'load-geolocation-module',
    });
    return null;
  }
};

const loadMapsModule = (): MapsModule | null => {
  if (cachedMapsModule !== undefined) {
    return cachedMapsModule;
  }

  try {
    cachedMapsModule = require('@maplibre/maplibre-react-native') as MapsModule;
    return cachedMapsModule;
  } catch (error) {
    cachedMapsModule = null;
    reportError(error, {
      source: 'load-maps-module',
    });
    return null;
  }
};

const loadSafeAreaViewComponent = (): React.ComponentType<any> => {
  if (cachedSafeAreaViewComponent) {
    return cachedSafeAreaViewComponent;
  }

  try {
    cachedSafeAreaViewComponent = (
      require('react-native-safe-area-context') as {
        SafeAreaView: React.ComponentType<any>;
      }
    ).SafeAreaView;
  } catch (error) {
    cachedSafeAreaViewComponent = LegacySafeAreaView;
    reportError(error, {
      source: 'load-safe-area-view',
    });
  }

  return cachedSafeAreaViewComponent;
};

const isValidCoordinateValue = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

const isSavedPoint = (value: unknown): value is SavedPoint => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<SavedPoint>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    isValidCoordinateValue(candidate.latitude, -90, 90) &&
    isValidCoordinateValue(candidate.longitude, -180, 180)
  );
};

type MapRenderBoundaryProps = {
  children: React.ReactNode;
};

type MapRenderBoundaryState = {
  hasError: boolean;
};

class MapRenderBoundary extends React.Component<
  MapRenderBoundaryProps,
  MapRenderBoundaryState
> {
  state: MapRenderBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError() {
    return {hasError: true};
  }

  componentDidCatch(error: Error) {
    reportError(error, {
      source: 'map-render-boundary',
    });
    console.warn('Map render failed', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.mapFallback}>
          <Text style={styles.mapFallbackTitle}>地图暂时不可用</Text>
          <Text style={styles.mapFallbackText}>
            当前设备的地图模块加载失败，应用其他功能仍可继续使用。
          </Text>
        </View>
      );
    }

    return this.props.children;
  }
}

function App() {
  const [currentLocation, setCurrentLocation] = useState<Coordinate | null>(null);
  const [targetLocation, setTargetLocation] = useState<Coordinate>(DEFAULT_TARGET);
  const [targetLatInput, setTargetLatInput] = useState(String(DEFAULT_TARGET.latitude));
  const [targetLngInput, setTargetLngInput] = useState(String(DEFAULT_TARGET.longitude));
  const [pointNameInput, setPointNameInput] = useState('');
  const [savedPoints, setSavedPoints] = useState<SavedPoint[]>([]);
  const [shouldRenderEmbeddedMap, setShouldRenderEmbeddedMap] = useState(true);
  const [debugModeEnabled, setDebugModeEnabled] = useState(false);
  const [debugLogsText, setDebugLogsText] = useState('');
  const [isDebugPullArmed, setIsDebugPullArmed] = useState(false);
  const [showUserManual, setShowUserManual] = useState(true);

  const lastTitleTapAtRef = useRef(0);
  const lastTitleDoubleTapAtRef = useRef(0);
  const titleDoubleTapCountRef = useRef(0);
  const scrollOffsetYRef = useRef(0);
  const pullGestureStartedAtTopRef = useRef(false);
  const pullGesturePassedThresholdRef = useRef(false);
  const debugPullCountRef = useRef(0);

  const mapsModule = shouldRenderEmbeddedMap ? loadMapsModule() : null;
  const SafeAreaViewComponent = loadSafeAreaViewComponent();
  const MapViewComponent = mapsModule?.MapView;
  const CameraComponent = mapsModule?.Camera;
  const PointAnnotationComponent = mapsModule?.PointAnnotation;
  const ShapeSourceComponent = mapsModule?.ShapeSource;
  const LineLayerComponent = mapsModule?.LineLayer;
  const UserLocationComponent = mapsModule?.UserLocation;

  useEffect(() => {
    appendAppLog({
      source: 'app',
      message: '应用已打开',
      details: {
        platform: Platform.OS,
        version: APP_VERSION,
      },
    });
  }, []);

  useEffect(() => {
    if (!debugModeEnabled) {
      return;
    }

    setDebugLogsText(formatAppLogsForDisplay());

    return subscribeAppLogs(entries => {
      setDebugLogsText(formatAppLogsForDisplay(entries));
    });
  }, [debugModeEnabled]);

  useEffect(() => {
    appendAppLog({
      source: 'embedded-map',
      message: shouldRenderEmbeddedMap ? '内置地图加载已启用' : '内置地图首屏加载已关闭',
      details: {
        platform: Platform.OS,
      },
    });
  }, [shouldRenderEmbeddedMap]);

  useEffect(() => {
    const loadSavedPoints = async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) {
          appendAppLog({
            source: 'saved-points',
            message: '本地没有已保存点位',
          });
          return;
        }

        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const nextSavedPoints = parsed.filter(isSavedPoint).slice(0, 20);
          setSavedPoints(nextSavedPoints);
          appendAppLog({
            source: 'saved-points',
            message: '已加载本地点位',
            details: {
              count: nextSavedPoints.length,
            },
          });
        }
      } catch {
        reportError(new Error('Failed to load saved points'), {
          source: 'load-saved-points',
        });
        Alert.alert('读取失败', '本地保存的点位读取失败。');
      }
    };

    loadSavedPoints();
  }, []);

  const mapCenterCoordinate = useMemo<[number, number]>(() => {
    if (currentLocation) {
      return [
        (currentLocation.longitude + targetLocation.longitude) / 2,
        (currentLocation.latitude + targetLocation.latitude) / 2,
      ];
    }

    return [targetLocation.longitude, targetLocation.latitude];
  }, [currentLocation, targetLocation]);

  const mapZoomLevel = currentLocation ? 10.5 : 13.5;

  const routeGeoJson = useMemo(() => {
    if (!currentLocation) {
      return null;
    }

    return {
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [currentLocation.longitude, currentLocation.latitude],
          [targetLocation.longitude, targetLocation.latitude],
        ],
      },
      properties: {},
    };
  }, [currentLocation, targetLocation]);

  const resetDebugGestureProgress = () => {
    titleDoubleTapCountRef.current = 0;
    lastTitleTapAtRef.current = 0;
    lastTitleDoubleTapAtRef.current = 0;
    debugPullCountRef.current = 0;
    pullGestureStartedAtTopRef.current = false;
    pullGesturePassedThresholdRef.current = false;
    setIsDebugPullArmed(false);
  };

  const activateDebugMode = () => {
    if (debugModeEnabled) {
      return;
    }

    setDebugModeEnabled(true);
    appendAppLog({
      source: 'debug-mode',
      message: '调试模式已开启',
    });
    resetDebugGestureProgress();
    Alert.alert('调试模式已开启', '滑到页面最底部即可查看应用日志，长按日志内容可以复制。');
  };

  const handleTitlePress = () => {
    if (debugModeEnabled) {
      return;
    }

    const now = Date.now();

    if (
      lastTitleTapAtRef.current > 0 &&
      now - lastTitleTapAtRef.current <= TITLE_DOUBLE_TAP_WINDOW_MS
    ) {
      const nextDoubleTapCount =
        lastTitleDoubleTapAtRef.current > 0 &&
        now - lastTitleDoubleTapAtRef.current <= TITLE_SEQUENCE_WINDOW_MS
          ? titleDoubleTapCountRef.current + 1
          : 1;

      titleDoubleTapCountRef.current = nextDoubleTapCount;
      lastTitleDoubleTapAtRef.current = now;
      lastTitleTapAtRef.current = 0;

      if (nextDoubleTapCount >= 3) {
        setIsDebugPullArmed(true);
        debugPullCountRef.current = 0;
        appendAppLog({
          source: 'debug-mode',
          message: '调试模式入口已识别，等待顶部下拉确认',
        });
        titleDoubleTapCountRef.current = 0;
        lastTitleDoubleTapAtRef.current = 0;
      }

      return;
    }

    if (
      lastTitleDoubleTapAtRef.current > 0 &&
      now - lastTitleDoubleTapAtRef.current > TITLE_SEQUENCE_WINDOW_MS
    ) {
      titleDoubleTapCountRef.current = 0;
    }

    lastTitleTapAtRef.current = now;
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    scrollOffsetYRef.current = offsetY;

    if (
      isDebugPullArmed &&
      pullGestureStartedAtTopRef.current &&
      offsetY <= -DEBUG_PULL_DISTANCE
    ) {
      pullGesturePassedThresholdRef.current = true;
    }
  };

  const handleScrollBeginDrag = () => {
    if (!isDebugPullArmed || debugModeEnabled) {
      return;
    }

    pullGestureStartedAtTopRef.current = scrollOffsetYRef.current <= 4;
    pullGesturePassedThresholdRef.current = false;
  };

  const handleScrollEndDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetYRef.current = event.nativeEvent.contentOffset.y;

    if (!isDebugPullArmed || debugModeEnabled) {
      return;
    }

    const velocityY = event.nativeEvent.velocity?.y ?? 0;
    const didPullDownFromTop =
      pullGestureStartedAtTopRef.current &&
      (pullGesturePassedThresholdRef.current ||
        (event.nativeEvent.contentOffset.y <= 0 && velocityY < -0.45));

    pullGestureStartedAtTopRef.current = false;
    pullGesturePassedThresholdRef.current = false;

    if (!didPullDownFromTop) {
      return;
    }

    const nextPullCount = debugPullCountRef.current + 1;
    debugPullCountRef.current = nextPullCount;
    appendAppLog({
      source: 'debug-mode',
      message: '调试模式顶部下拉确认',
      details: {
        step: nextPullCount,
        total: DEBUG_PULL_TARGET,
      },
    });

    if (nextPullCount >= DEBUG_PULL_TARGET) {
      activateDebugMode();
    }
  };

  const parseInputCoordinate = (): Coordinate | null => {
    const lat = Number.parseFloat(targetLatInput);
    const lng = Number.parseFloat(targetLngInput);

    const isInvalid =
      Number.isNaN(lat) ||
      Number.isNaN(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180;

    if (isInvalid) {
      appendAppLog({
        level: 'warn',
        source: 'target-input',
        message: '输入的目标坐标无效',
        details: {
          latitude: targetLatInput,
          longitude: targetLngInput,
        },
      });
      Alert.alert('坐标无效', '请填写合法经纬度。\n纬度范围: -90~90\n经度范围: -180~180');
      return null;
    }

    return {latitude: lat, longitude: lng};
  };

  const requestLocationPermission = async () => {
    const geolocation = loadGeolocationModule();
    if (!geolocation) {
      appendAppLog({
        level: 'warn',
        source: 'location-permission',
        message: '定位模块未成功加载',
      });
      Alert.alert('定位暂不可用', '当前设备未成功加载定位模块，请稍后重试。');
      return false;
    }

    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      appendAppLog({
        source: 'location-permission',
        message: 'Android 定位权限申请完成',
        details: {
          granted,
        },
      });
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }

    const result = await geolocation.requestAuthorization?.('whenInUse');
    appendAppLog({
      source: 'location-permission',
      message: 'iOS 定位权限申请完成',
      details: {
        result: result ?? 'unknown',
      },
    });
    return result === 'granted';
  };

  const locateMe = async () => {
    const geolocation = loadGeolocationModule();
    if (!geolocation) {
      appendAppLog({
        level: 'warn',
        source: 'geolocation',
        message: '定位模块未成功加载',
      });
      Alert.alert('定位暂不可用', '当前设备未成功加载定位模块，请稍后重试。');
      return;
    }

    appendAppLog({
      source: 'geolocation',
      message: '开始获取当前位置',
    });

    const hasPermission = await requestLocationPermission();
    if (!hasPermission) {
      appendAppLog({
        level: 'warn',
        source: 'location-permission',
        message: '定位权限未开启',
      });
      Alert.alert('权限未开启', '请允许定位权限后再重试。');
      return;
    }

    geolocation.getCurrentPosition(
      position => {
        setCurrentLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        appendAppLog({
          source: 'geolocation',
          message: '当前位置获取成功',
          details: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          },
        });
      },
      error => {
        reportError(new Error(error.message), {
          source: 'geolocation',
          extra: {
            code: error.code,
          },
        });
        Alert.alert('定位失败', error.message);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 10000,
      },
    );
  };

  const updateTargetFromInput = () => {
    const coordinate = parseInputCoordinate();
    if (!coordinate) {
      return;
    }

    setTargetLocation(coordinate);
    appendAppLog({
      source: 'target-input',
      message: '目标坐标已更新',
      details: coordinate,
    });
  };

  const savePoint = async () => {
    const coordinate = parseInputCoordinate();
    if (!coordinate) {
      return;
    }

    setTargetLocation(coordinate);

    const name = pointNameInput.trim() || `点位 ${savedPoints.length + 1}`;
    const nextPoint: SavedPoint = {
      id: `${Date.now()}`,
      name,
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
    };

    const nextSavedPoints = [nextPoint, ...savedPoints].slice(0, 20);

    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextSavedPoints));
      setSavedPoints(nextSavedPoints);
      setPointNameInput('');
      appendAppLog({
        source: 'saved-points',
        message: '目标点位已保存',
        details: nextPoint,
      });
      Alert.alert('已保存', `已记住点位: ${name}`);
    } catch {
      reportError(new Error('Failed to save target point'), {
        source: 'save-point',
      });
      Alert.alert('保存失败', '本地点位保存失败，请重试。');
    }
  };

  const openInAmap = async () => {
    const coordinate = parseInputCoordinate();
    if (!coordinate) {
      return;
    }

    setTargetLocation(coordinate);

    const targetName = pointNameInput.trim() || '目标地点';
    const amapUrl =
      `amapuri://route/plan/?sourceApplication=${encodeURIComponent('扫个墓')}` +
      `&dlat=${coordinate.latitude}` +
      `&dlon=${coordinate.longitude}` +
      `&dname=${encodeURIComponent(targetName)}` +
      '&dev=0&t=0';

    try {
      appendAppLog({
        source: 'open-amap',
        message: '尝试打开高德地图导航',
        details: {
          targetName,
          latitude: coordinate.latitude,
          longitude: coordinate.longitude,
        },
      });

      const supported = await Linking.canOpenURL(amapUrl);
      if (!supported) {
        appendAppLog({
          level: 'warn',
          source: 'open-amap',
          message: '设备未检测到高德地图',
        });
        Alert.alert('未检测到高德地图', '请先安装高德地图后再尝试导航。');
        return;
      }

      await Linking.openURL(amapUrl);
      appendAppLog({
        source: 'open-amap',
        message: '已交给高德地图处理导航',
      });
    } catch {
      reportError(new Error('Failed to open amap navigation'), {
        source: 'open-amap',
      });
      Alert.alert('打开失败', '暂时无法打开高德地图，请稍后再试。');
    }
  };

  const applySavedPoint = (point: SavedPoint) => {
    setTargetLocation({latitude: point.latitude, longitude: point.longitude});
    setTargetLatInput(String(point.latitude));
    setTargetLngInput(String(point.longitude));
    setPointNameInput(point.name);
    appendAppLog({
      source: 'saved-points',
      message: '已载入保存点位为目标点',
      details: point,
    });
  };

  const enableEmbeddedMap = () => {
    appendAppLog({
      source: 'embedded-map',
      message: '用户手动尝试加载内置地图',
    });
    setShouldRenderEmbeddedMap(true);
  };

  const openSystemLocationSettings = async () => {
    appendAppLog({
      source: 'location-settings',
      message: '尝试打开系统定位设置',
    });

    try {
      await Linking.openSettings();
    } catch {
      reportError(new Error('Failed to open system settings'), {
        source: 'location-settings',
      });
      Alert.alert('打开失败', '暂时无法打开系统设置，请手动到系统设置中开启定位权限和定位服务。');
    }
  };

  return (
    <SafeAreaViewComponent style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.blobTop} />
      <View style={styles.blobBottom} />

      <ScrollView
        contentContainerStyle={styles.page}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        scrollEventThrottle={16}>
        <View style={styles.heroCard}>
          <Text style={styles.badge}>GPS 纪念路线</Text>
          <Pressable hitSlop={8} onPress={handleTitlePress}>
            <Text style={styles.title}>扫墓定位助手</Text>
          </Pressable>
          <Text style={styles.subtitle}>记住每一个墓地点位，下次打开就能直接导航连线</Text>
          {isDebugPullArmed ? (
            <Text style={styles.debugTip}>继续在页面顶部从上往下拉 3 次，即可开启调试模式</Text>
          ) : null}
        </View>

        <View style={styles.panelCard}>
          <Pressable style={styles.manualHeader} onPress={() => setShowUserManual(value => !value)}>
            <Text style={styles.sectionTitle}>用户使用手册</Text>
            <Text style={styles.manualToggle}>{showUserManual ? '收起' : '展开'}</Text>
          </Pressable>

          {showUserManual ? (
            <>
              <Text style={styles.manualText}>1. 先点“获取我当前位置”，首次使用时请允许定位权限。</Text>
              <Text style={styles.manualText}>2. 如果还是定位失败，请先在手机系统里打开“定位服务/GPS”，再回到应用重试。</Text>
              <Text style={styles.manualText}>3. 手动输入目标经纬度后，可以直接点“打开高德地图导航”，也可以先点“更新目标坐标”。</Text>
              <Text style={styles.manualText}>4. 常去的墓地点可以点“保存这个目标点位”，下次直接点已保存点位即可载入。</Text>
              <Text style={styles.manualText}>5. 调试日志入口：连续双击“扫墓定位助手”3次，再在页面顶部下拉3次。</Text>
              <Pressable style={styles.buttonOutline} onPress={openSystemLocationSettings}>
                <Text style={styles.buttonOutlineText}>打开系统设置排查定位</Text>
              </Pressable>
            </>
          ) : null}
        </View>

        <View style={styles.mapCard}>
          {MapViewComponent &&
          CameraComponent &&
          PointAnnotationComponent &&
          ShapeSourceComponent &&
          LineLayerComponent &&
          UserLocationComponent ? (
            <MapRenderBoundary>
              <MapViewComponent
                style={styles.map}
                mapStyle={OPEN_FREE_MAP_STYLE_URL}
                compassEnabled
                logoEnabled={false}
                rotateEnabled
                pitchEnabled
                onDidFinishLoadingMap={() => {
                  appendAppLog({
                    source: 'embedded-map',
                    message: 'OpenFreeMap 地图加载完成',
                  });
                }}
                onDidFailLoadingMap={() => {
                  reportError(new Error('MapLibre failed to load map style'), {
                    source: 'embedded-map',
                  });
                }}>
                <CameraComponent
                  defaultSettings={{
                    centerCoordinate: mapCenterCoordinate,
                    zoomLevel: mapZoomLevel,
                  }}
                  centerCoordinate={mapCenterCoordinate}
                  zoomLevel={mapZoomLevel}
                  animationDuration={600}
                />

                <UserLocationComponent
                  visible
                  animated
                  renderMode="native"
                  androidRenderMode="gps"
                  showsUserHeadingIndicator
                  minDisplacement={1}
                  onUpdate={(location: {coords?: Coordinate}) => {
                    const coords = location?.coords;
                    if (!coords) {
                      return;
                    }

                    appendAppLog({
                      source: 'map-user-location',
                      message: '地图内置定位已更新',
                      details: {
                        latitude: coords.latitude,
                        longitude: coords.longitude,
                      },
                    });
                  }}
                />

                <PointAnnotationComponent
                  id="target-location"
                  coordinate={[targetLocation.longitude, targetLocation.latitude]}>
                  <View style={styles.targetMarker}>
                    <View style={styles.targetMarkerDot} />
                  </View>
                </PointAnnotationComponent>

                {currentLocation ? (
                  <PointAnnotationComponent
                    id="current-location"
                    coordinate={[currentLocation.longitude, currentLocation.latitude]}>
                    <View style={styles.currentMarker}>
                      <View style={styles.currentMarkerDot} />
                    </View>
                  </PointAnnotationComponent>
                ) : null}

                {routeGeoJson ? (
                  <ShapeSourceComponent id="route-source" shape={routeGeoJson}>
                    <LineLayerComponent
                      id="route-line"
                      style={ROUTE_LINE_STYLE}
                    />
                  </ShapeSourceComponent>
                ) : null}
              </MapViewComponent>
            </MapRenderBoundary>
          ) : (
            <View style={styles.mapFallback}>
              <Text style={styles.mapFallbackTitle}>OpenFreeMap 地图暂不可用</Text>
              <Text style={styles.mapFallbackText}>
                当前设备还没有完成 MapLibre 原生模块加载。重新编译应用后，就会使用
                OpenFreeMap 作为内置地图底图。
              </Text>
              <Pressable style={styles.mapFallbackButton} onPress={enableEmbeddedMap}>
                <Text style={styles.mapFallbackButtonText}>重试加载地图</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.mapInfoBar}>
            <Text style={styles.mapInfoText}>底图: OpenFreeMap / MapLibre</Text>
            <Text style={styles.mapInfoText}>
              当前点:{' '}
              {currentLocation
                ? `${currentLocation.latitude.toFixed(5)}, ${currentLocation.longitude.toFixed(5)}`
                : '未定位'}
            </Text>
            <Text style={styles.mapInfoText}>
              目标点: {targetLocation.latitude.toFixed(5)}, {targetLocation.longitude.toFixed(5)}
            </Text>
          </View>
        </View>

        <View style={styles.panelCard}>
          <Text style={styles.sectionTitle}>目标信息</Text>

          <TextInput
            style={styles.input}
            value={pointNameInput}
            onChangeText={setPointNameInput}
            placeholder="点位名称（例如：爷爷墓地）"
            placeholderTextColor="#94a3b8"
          />

          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, styles.inputHalf]}
              value={targetLatInput}
              onChangeText={setTargetLatInput}
              keyboardType="decimal-pad"
              placeholder="目标纬度"
              placeholderTextColor="#94a3b8"
            />
            <TextInput
              style={[styles.input, styles.inputHalf]}
              value={targetLngInput}
              onChangeText={setTargetLngInput}
              keyboardType="decimal-pad"
              placeholder="目标经度"
              placeholderTextColor="#94a3b8"
            />
          </View>

          <View style={styles.buttonRow}>
            <Pressable style={styles.buttonBlue} onPress={locateMe}>
              <Text style={styles.buttonBlueText}>获取我当前位置</Text>
            </Pressable>
            <Pressable style={styles.buttonMint} onPress={updateTargetFromInput}>
              <Text style={styles.buttonMintText}>更新目标坐标</Text>
            </Pressable>
          </View>

          <Pressable style={styles.buttonSave} onPress={savePoint}>
            <Text style={styles.buttonSaveText}>保存这个目标点位</Text>
          </Pressable>

          <Pressable style={styles.buttonAmap} onPress={openInAmap}>
            <Text style={styles.buttonAmapText}>打开高德地图导航</Text>
          </Pressable>
        </View>

        <View style={styles.panelCard}>
          <Text style={styles.sectionTitle}>已保存点位</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.savedPointList}>
            {savedPoints.length === 0 ? (
              <Text style={styles.emptyText}>还没有保存点位，先保存一个吧。</Text>
            ) : (
              savedPoints.map(point => (
                <Pressable
                  key={point.id}
                  style={styles.savedPointChip}
                  onPress={() => applySavedPoint(point)}>
                  <Text style={styles.savedPointName}>{point.name}</Text>
                  <Text style={styles.savedPointCoord}>
                    {point.latitude.toFixed(4)}, {point.longitude.toFixed(4)}
                  </Text>
                  <Text style={styles.savedPointTip}>点击载入为目标点</Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        </View>

        {debugModeEnabled ? (
          <View style={styles.panelCard}>
            <Text style={styles.sectionTitle}>应用日志</Text>
            <Text style={styles.logHint}>长按下面内容即可复制，日志会持续追加当前应用动作与错误信息。</Text>
            <Text style={styles.logMeta}>
              版本 {APP_VERSION} · {Platform.OS}
            </Text>
            <TextInput
              style={styles.logViewer}
              value={debugLogsText}
              editable={false}
              multiline
              selectTextOnFocus
              textAlignVertical="top"
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaViewComponent>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#eef6ff',
  },
  page: {
    padding: 16,
    paddingBottom: 28,
    gap: 14,
  },
  blobTop: {
    position: 'absolute',
    top: -80,
    right: -30,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: '#c7e0ff',
  },
  blobBottom: {
    position: 'absolute',
    bottom: -120,
    left: -40,
    width: 240,
    height: 240,
    borderRadius: 999,
    backgroundColor: '#d6f5e8',
  },
  heroCard: {
    borderRadius: 20,
    backgroundColor: '#0f172a',
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: '#1e293b',
    color: '#93c5fd',
    fontSize: 12,
    fontWeight: '700',
  },
  title: {
    marginTop: 10,
    color: '#f8fafc',
    fontSize: 26,
    fontWeight: '800',
  },
  subtitle: {
    marginTop: 6,
    color: '#cbd5e1',
    fontSize: 14,
    lineHeight: 20,
  },
  debugTip: {
    marginTop: 10,
    color: '#fde68a',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700',
  },
  mapCard: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dbeafe',
  },
  map: {
    height: 280,
    width: '100%',
  },
  targetMarker: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(245, 158, 11, 0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  targetMarkerDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: '#f59e0b',
  },
  currentMarker: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(14, 165, 233, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#0ea5e9',
  },
  currentMarkerDot: {
    width: 9,
    height: 9,
    borderRadius: 999,
    backgroundColor: '#0ea5e9',
  },
  mapFallback: {
    height: 280,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#dbeafe',
  },
  mapFallbackTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '800',
  },
  mapFallbackText: {
    marginTop: 8,
    color: '#334155',
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  mapFallbackButton: {
    marginTop: 14,
    borderRadius: 12,
    backgroundColor: '#2563eb',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  mapFallbackButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  mapInfoBar: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
    backgroundColor: '#f8fafc',
  },
  mapInfoText: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '600',
  },
  panelCard: {
    borderRadius: 18,
    backgroundColor: '#ffffff',
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 10,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f172a',
  },
  manualHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  manualToggle: {
    color: '#2563eb',
    fontSize: 13,
    fontWeight: '700',
  },
  manualText: {
    color: '#334155',
    fontSize: 13,
    lineHeight: 20,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  input: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    color: '#0f172a',
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 14,
  },
  inputHalf: {
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  buttonBlue: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    backgroundColor: '#2563eb',
    alignItems: 'center',
  },
  buttonBlueText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 13,
  },
  buttonMint: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    backgroundColor: '#ccfbf1',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#14b8a6',
  },
  buttonMintText: {
    color: '#0f766e',
    fontWeight: '700',
    fontSize: 13,
  },
  buttonSave: {
    borderRadius: 12,
    paddingVertical: 13,
    backgroundColor: '#065f46',
    alignItems: 'center',
  },
  buttonSaveText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
  },
  buttonAmap: {
    borderRadius: 12,
    paddingVertical: 13,
    backgroundColor: '#f59e0b',
    alignItems: 'center',
  },
  buttonAmapText: {
    color: '#1f2937',
    fontWeight: '800',
    fontSize: 14,
  },
  buttonOutline: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  buttonOutlineText: {
    color: '#1d4ed8',
    fontWeight: '700',
    fontSize: 13,
  },
  savedPointList: {
    gap: 10,
    paddingVertical: 2,
  },
  emptyText: {
    color: '#64748b',
    fontSize: 13,
    paddingVertical: 6,
  },
  savedPointChip: {
    minWidth: 175,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    backgroundColor: '#eff6ff',
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  savedPointName: {
    color: '#1e3a8a',
    fontWeight: '800',
    fontSize: 13,
  },
  savedPointCoord: {
    marginTop: 2,
    color: '#334155',
    fontSize: 12,
  },
  savedPointTip: {
    marginTop: 4,
    color: '#0f766e',
    fontSize: 11,
    fontWeight: '600',
  },
  logHint: {
    color: '#475569',
    fontSize: 12,
    lineHeight: 18,
  },
  logMeta: {
    color: '#0f766e',
    fontSize: 12,
    fontWeight: '700',
  },
  logViewer: {
    minHeight: 220,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
    backgroundColor: '#0f172a',
    color: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 12,
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
  },
});

export default App;
