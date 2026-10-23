import { render } from 'ink';
import { App, type TuiPlan } from './app.js';

export interface RunTuiOptions {
  plan: TuiPlan;
  onApply: () => Promise<void> | void;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  return new Promise((resolve) => {
    const { unmount } = render(
      <App
        plan={options.plan}
        onApply={async () => {
          unmount();
          await options.onApply();
          resolve();
        }}
        onQuit={() => {
          unmount();
          resolve();
        }}
      />,
    );
  });
}
