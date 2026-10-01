import { useBoundHero, useThemedRoleLookup } from '../../../lib/hooks';
import { useOfficeStore } from '../../../stores/officeStore';
import { Sheet } from '../../../components/Sheet';
import { Checkbox } from '../../../components/ui';
import { AgentDetails } from '../AgentDetails';

/**
 * The full record of the selected character in a `Sheet` (focus in, Tab trapped, Esc closes it, focus
 * back on the Details button; `data-modal` keeps the global hotkeys quiet). On phones the compact card
 * has no Follow toggle, so it lives here.
 */
export function AgentDetailsDialog({ agentId, onClose, compact, follow, onFollowChange }: { agentId: string; onClose: () => void; compact: boolean; follow: boolean; onFollowChange: (follow: boolean) => void }) {
  const agent = useOfficeStore((s) => s.agents[agentId]);
  const hero = useBoundHero(agentId);
  const role = useThemedRoleLookup()(agent?.role, { projectId: agent?.projectId, hero });
  return (
    <Sheet id="agent-details" title={agent ? (hero ? `${hero.name} · ${role.themedTitle}` : role.themedTitle) : 'Agent left'} onClose={onClose} wide={false}>
      <div className="flex h-full min-h-0 flex-col">
        {agent && compact && (
          <div className="shrink-0 border-b border-ink-700 px-4 py-2">
            <Checkbox checked={follow} onChange={onFollowChange} label="Follow with the camera" />
          </div>
        )}
        <div className="min-h-0 flex-1">
          <AgentDetails agentId={agentId} />
        </div>
      </div>
    </Sheet>
  );
}
