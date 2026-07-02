import React from 'react';
import { router } from 'expo-router';
import { EntryScannerScreen } from '../src/screens/EntryScannerScreen';
import { AppEntryQr } from '../src/models';

export default function IndexRoute() {
  const handleResolved = (entry: AppEntryQr) => {
    if (entry.type === 'table') {
      router.replace(`/mesa/${entry.table_number}` as any);
    } else if (entry.type === 'waiter') {
      router.replace('/waiter' as any);
    } else if (entry.type === 'admin') {
      router.replace('/admin' as any);
    }
  };

  return <EntryScannerScreen onResolved={handleResolved} />;
}
