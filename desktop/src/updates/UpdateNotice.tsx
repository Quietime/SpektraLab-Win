import { useEffect, useState } from 'react';
import { tz } from '../i18n';
import { getUpdateStatus, subscribeUpdates, type UpdateStatus } from './service';

export function UpdateNotice() {
  const [update, setUpdate] = useState<UpdateStatus>(getUpdateStatus());
  useEffect(() => subscribeUpdates(setUpdate), []);
  if (!update.available || update.error) return null;
  return <div role="status" style={{ position: 'fixed', zIndex: 40, right: 18, bottom: 18, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--rule)', boxShadow: '0 4px 18px #0006' }}>
    <span>{tz('SpektraLab update available', 'SpektraLab 有可用更新')}{update.version ? ` · ${update.version}` : ''}</span>
    <button className="btn" onClick={() => window.dispatchEvent(new Event('spektralab-open-update-settings'))}>
      {tz('View update', '查看更新')}
    </button>
  </div>;
}
