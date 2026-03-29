import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {useEffect, useMemo, useState} from 'react';
import {
  Alert,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import MapView, {Marker, Polyline} from 'react-native-maps';
import {SafeAreaView} from 'react-native-safe-area-context';

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

  useEffect(() => {
    const loadSavedPoints = async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) {
          return;
        }

        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          setSavedPoints(parsed.filter(isSavedPoint).slice(0, 20));
        }
      } catch {
        Alert.alert('读取失败', '本地保存的点位读取失败。');
      }
    };

    loadSavedPoints();
  }, []);

  const mapRegion = useMemo(() => {
    if (currentLocation) {
      return {
        latitude: (currentLocation.latitude + targetLocation.latitude) / 2,
        longitude: (currentLocation.longitude + targetLocation.longitude) / 2,
        latitudeDelta: Math.max(
          Math.abs(currentLocation.latitude - targetLocation.latitude) * 1.8,
          0.02,
        ),
        longitudeDelta: Math.max(
          Math.abs(currentLocation.longitude - targetLocation.longitude) * 1.8,
          0.02,
        ),
      };
    }

    return {
      latitude: targetLocation.latitude,
      longitude: targetLocation.longitude,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    };
  }, [currentLocation, targetLocation]);

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
      Alert.alert('坐标无效', '请填写合法经纬度。\n纬度范围: -90~90\n经度范围: -180~180');
      return null;
    }

    return {latitude: lat, longitude: lng};
  };

  const requestLocationPermission = async () => {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }

    const result = await Geolocation.requestAuthorization('whenInUse');
    return result === 'granted';
  };

  const locateMe = async () => {
    const hasPermission = await requestLocationPermission();
    if (!hasPermission) {
      Alert.alert('权限未开启', '请允许定位权限后再重试。');
      return;
    }

    Geolocation.getCurrentPosition(
      position => {
        setCurrentLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      error => {
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
  };

  const savePoint = async () => {
    const coordinate = parseInputCoordinate();
    if (!coordinate) {
      return;
    }

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
      Alert.alert('已保存', `已记住点位: ${name}`);
    } catch {
      Alert.alert('保存失败', '本地点位保存失败，请重试。');
    }
  };

  const openInAmap = async () => {
    const targetName = pointNameInput.trim() || '目标地点';
    const amapUrl =
      `amapuri://route/plan/?sourceApplication=${encodeURIComponent('扫个墓')}` +
      `&dlat=${targetLocation.latitude}` +
      `&dlon=${targetLocation.longitude}` +
      `&dname=${encodeURIComponent(targetName)}` +
      '&dev=0&t=0';

    try {
      const supported = await Linking.canOpenURL(amapUrl);
      if (!supported) {
        Alert.alert('未检测到高德地图', '请先安装高德地图后再尝试导航。');
        return;
      }

      await Linking.openURL(amapUrl);
    } catch {
      Alert.alert('打开失败', '暂时无法打开高德地图，请稍后再试。');
    }
  };

  const applySavedPoint = (point: SavedPoint) => {
    setTargetLocation({latitude: point.latitude, longitude: point.longitude});
    setTargetLatInput(String(point.latitude));
    setTargetLngInput(String(point.longitude));
    setPointNameInput(point.name);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.blobTop} />
      <View style={styles.blobBottom} />

      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.heroCard}>
          <Text style={styles.badge}>GPS 纪念路线</Text>
          <Text style={styles.title}>扫墓定位助手</Text>
          <Text style={styles.subtitle}>记住每一个墓地点位，下次打开就能直接导航连线</Text>
        </View>

        <View style={styles.mapCard}>
          <MapRenderBoundary>
            <MapView style={styles.map} region={mapRegion}>
              <Marker coordinate={targetLocation} title="目标地点" pinColor="#f59e0b" />

              {currentLocation ? (
                <>
                  <Marker coordinate={currentLocation} title="我的位置" pinColor="#0ea5e9" />
                  <Polyline
                    coordinates={[currentLocation, targetLocation]}
                    strokeColor="#ef4444"
                    strokeWidth={4}
                  />
                </>
              ) : null}
            </MapView>
          </MapRenderBoundary>
          <View style={styles.mapInfoBar}>
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
      </ScrollView>
    </SafeAreaView>
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
});

export default App;
