import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import 'react-native-reanimated';
import { AppBootstrap } from '../src/components/AppBootstrap';
import { initDb } from '../src/repositories/LocalDatabase';
import { Colors } from '../src/constants/Colors';

export {
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    ...FontAwesome.font,
  });
  const [dbReady, setDbReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    const initializeApp = async () => {
      try {
        console.log('[RootLayout] Initializing local database');
        await initDb();
        console.log('[RootLayout] Database ready');
      } catch (e) {
        console.error('Failed to init DB', e);
        setInitError('No se pudo inicializar la base local.');
      } finally {
        setDbReady(true);
      }
    };
    initializeApp();
  }, []);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded || !dbReady) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: Colors.background,
        }}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return <RootLayoutNav initError={initError} />;
}

function RootLayoutNav({ initError }: { initError: string | null }) {
  const navigationTheme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: Colors.background,
      card: Colors.surface,
      text: Colors.text,
      border: Colors.border,
      primary: Colors.primary,
      notification: Colors.secondary,
    },
  };

  return (
    <ThemeProvider value={navigationTheme}>
      <AppBootstrap />
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
      </Stack>
      {initError ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 50,
            left: 16,
            right: 16,
            padding: 12,
            borderRadius: 12,
            backgroundColor: '#c85f40',
          }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}>
            {initError}
          </Text>
        </View>
      ) : null}
    </ThemeProvider>
  );
}
