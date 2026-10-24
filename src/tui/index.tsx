import { render } from 'ink';
import type { Plan } from '../model/types.js';
import { App } from './app.js';

/**
 * Open the interactive review and resolve with the edited plan, or `null` if
 * the user quit without applying.
 */
export async function runTui(plan: Plan): Promise<Plan | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Plan | null): void => {
      if (settled) return;
      settled = true;
      instance.unmount();
      resolve(value);
    };
    const instance = render(
      <App plan={plan} onApply={finish} onQuit={() => finish(null)} />,
    );
  });
}
