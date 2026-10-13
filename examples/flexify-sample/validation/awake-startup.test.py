import copy
import importlib.util
import pathlib
import unittest


spec = importlib.util.spec_from_file_location(
    'awake_startup', pathlib.Path(__file__).with_name('run-awake-startup.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class AwakeEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.sample = {
            'atMs': 1000, 'monotonicMs': 1000,
            'ioConsoleLocked': False, 'sessionScreenLocked': None,
            'sessionOnConsole': True, 'frontmostBundleId': 'com.openai.codex',
            'displays': [{'id': 1, 'active': True, 'asleep': False}],
            'displayQueryError': 0,
        }

    def report(self, samples, errors=None):
        return runner.summarize_environment(samples, errors or [])

    def test_root_lock_false_does_not_override_display_sleep(self):
        self.sample['displays'][0]['asleep'] = True
        result = self.report([self.sample])
        self.assertEqual(result['status'], 'inactive')
        self.assertIn('display_asleep', result['signals'])

    def test_root_lock_false_does_not_override_loginwindow(self):
        self.sample['frontmostBundleId'] = 'com.apple.loginwindow'
        result = self.report([self.sample])
        self.assertEqual(result['status'], 'inactive')
        self.assertIn('login_or_screensaver_frontmost', result['signals'])

    def test_missing_probe_and_sampling_gap_cannot_certify_active_display(self):
        self.assertEqual(self.report([], ['probe unavailable'])['status'], 'unknown')
        later = copy.deepcopy(self.sample)
        later.update(atMs=4000, monotonicMs=4000)
        result = self.report([self.sample, later])
        self.assertEqual(result['status'], 'unknown')
        self.assertIn('sampling_gap', result['signals'])

    def test_active_display_is_observation_not_unlocked_claim(self):
        result = self.report([self.sample])
        self.assertEqual(result['status'], 'active_display_observed')
        self.assertIsNone(self.sample['sessionScreenLocked'])
        self.assertNotIn('allSamplesUnlocked', result)

    def test_unbundled_frontmost_process_is_observed_by_pid(self):
        self.sample.update(frontmostBundleId=None, frontmostPid=67258)
        result = self.report([self.sample])
        self.assertEqual(result['status'], 'active_display_observed')
        self.assertNotIn('incomplete_environment_sample', result['signals'])
        self.assertIsNone(self.sample['frontmostBundleId'])

    def test_missing_frontmost_identity_remains_unknown(self):
        for pid in (None, 0, -1, '67258', True):
            with self.subTest(pid=pid):
                self.sample.update(frontmostBundleId=None, frontmostPid=pid)
                result = self.report([self.sample])
                self.assertEqual(result['status'], 'unknown')
                self.assertIn('incomplete_environment_sample', result['signals'])

    def test_inactive_environment_does_not_fail_successful_application_run(self):
        self.sample['ioConsoleLocked'] = True
        result = runner.summarize_results(
            [{'exitCode': 0, 'report': {'ok': True}}], [self.sample], [], 1)
        self.assertTrue(result['ok'])
        self.assertEqual(result['environment']['status'], 'inactive')
        self.assertTrue(result['environment']['guidance'])

    def test_display_awake_does_not_override_emulator_app_nap(self):
        state = {'atMs': 900, 'active': True, 'cpuThrottled': True}
        result = runner.summarize_results(
            [{'exitCode': 0, 'report': {'ok': True}}], [self.sample], [], 1, [state])
        self.assertTrue(result['ok'])
        self.assertIn('emulator_app_nap', result['environment']['signals'])
        self.assertEqual(result['environment']['status'], 'inactive')

    def test_no_app_nap_events_mean_unknown_not_disabled(self):
        result = runner.summarize_environment([self.sample], [], [])
        self.assertEqual(result['status'], 'unknown')

    def test_app_nap_log_scopes_pid_and_measurement_interval(self):
        def event(second, pid, active):
            return {
                'timestamp': f'2026-10-13 15:00:{second:02d}.000000+0800',
                'eventMessage': f'[anon<qemu-system-aarch64>(501):{pid}] Set AppNap state: '
                                f'<RBMutableProcessAppNapState|0x123 enabled:Y active:{active} '
                                f'socket:{active} disk:{active} priority:{active} cpu:{active} timer:Tier5>',
            }
        events = [event(0, 10, 'N'), event(1, 10, 'Y'), event(2, 11, 'N'),
                  event(4, 10, 'N'), event(6, 10, 'Y')]
        start = 1791874803000
        states = runner.app_nap_observations(events, 10, start, start + 2000)
        self.assertEqual([state['active'] for state in states], [True, False])
        self.assertEqual([state['pid'] for state in states], [10, 10])


if __name__ == '__main__':
    unittest.main()
