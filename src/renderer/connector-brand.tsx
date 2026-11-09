import type { CSSProperties } from 'react';
import type { ConnectorProvider } from '../shared/contracts';
import calendarLogo from '../../assets/connectors/calendar.png';
import cloakBrowserLogo from '../../assets/connectors/cloakbrowser.png';
import gmailLogo from '../../assets/connectors/gmail.png';
import githubLogo from '../../assets/connectors/github.png';
import qqMailLogo from '../../assets/connectors/qqmail.png';
import wechatLogo from '../../assets/connectors/wechat.svg';

export const CONNECTOR_LOGOS: Record<string, string> = {
  wechat: wechatLogo,
  gmail: gmailLogo,
  qqmail: qqMailLogo,
  cloakbrowser: cloakBrowserLogo,
  calendar: calendarLogo,
  github: githubLogo
};

export function ConnectorProviderIcon({ provider, className }: {
  provider: Pick<ConnectorProvider, 'id' | 'brandColor' | 'monogram'>;
  className: string;
}) {
  const logo = CONNECTOR_LOGOS[provider.id];
  return (
    <div className={className + (logo ? ' connector-icon-has-logo' : '')}
      style={{ '--connector-brand': provider.brandColor } as CSSProperties} aria-hidden="true">
      {logo ? <img className="connector-provider-logo" src={logo} alt="" /> : <span>{provider.monogram}</span>}
    </div>
  );
}
