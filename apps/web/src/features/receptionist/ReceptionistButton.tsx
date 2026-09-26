import { useRequireAdmin } from '../auth/useRequireAdmin';
import { useReceptionistUiStore } from './uiStore';
import { Button } from '../../components/ui';

/** TopBar entry point for the Receptionist chat panel (§4.1). Gated by `useRequireAdmin` the same way
 *  every other admin-only entry point in the top bar is: demo mode is always allowed, otherwise a
 *  missing admin session opens the pairing dialog instead of the panel. */
export function ReceptionistButton() {
  const openPanel = useReceptionistUiStore((s) => s.openPanel);
  const { guard } = useRequireAdmin();

  return (
    <Button variant="ghost" onClick={() => guard(() => openPanel())} title="Ask the Receptionist — a read-only help desk">
      Receptionist
    </Button>
  );
}
