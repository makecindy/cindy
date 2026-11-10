"""Native configuration and signed artifact checks for personal iOS builds (no device control)."""
import datetime
import fnmatch
import hashlib
import json
import pathlib
import plistlib
import re
import subprocess
import sys
import tempfile
import stat
import zipfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def plist(file):
    return plistlib.loads(file.read_bytes())


def configure(request):
    root = pathlib.Path(request['directory']) / 'apps/mobile/ios'
    identity = request['identity']
    bundle, group = identity['bundleId'], identity['appGroupId']
    changed = []
    for info_file in root.glob('*/Info.plist'):
        info = plist(info_file)
        info['CFBundleVersion'] = request['build']
        for key in ['ExpoShareIntoAppGroupId', 'AppGroupId', 'CindyAppGroupId']:
            if key in info:
                require(info[key] in ['group.' + bundle, group], 'Unexpected generated App Group')
                info[key] = group
                changed.append(key)
        info_file.write_bytes(plistlib.dumps(info))
    require(sorted(changed) == sorted(['ExpoShareIntoAppGroupId', 'AppGroupId', 'CindyAppGroupId']),
            'Expected main, sharing and widget App Group readers')
    count = 0
    for file in root.glob('*/*.entitlements'):
        ent = plist(file)
        key = 'com.apple.security.application-groups'
        if key in ent:
            require(ent[key] in [['group.' + bundle], [group]], 'Unexpected entitlement App Group')
            ent[key] = [group]
            file.write_bytes(plistlib.dumps(ent))
            count += 1
    require(count == 3, 'Expected three App Group entitlements')


def output(*args):
    result = subprocess.run(args, capture_output=True, check=False)
    require(result.returncode == 0, result.stderr.decode(errors='replace'))
    return result.stdout


def allows(value, permitted):
    if isinstance(value, list):
        return isinstance(permitted, list) and all(any(allows(v, p) for p in permitted) for v in value)
    if isinstance(value, str) and isinstance(permitted, str):
        return fnmatch.fnmatchcase(value, permitted)
    return value == permitted


def verify_push_environment(entitlements, profile_entitlements):
    environment = entitlements.get('aps-environment')
    require(environment in ['development', 'production'], 'Missing or invalid APNs signing environment')
    # ExpoApplication reads this profile at runtime, so it must agree with the
    # actual code signature, including Release builds signed for development.
    require(profile_entitlements.get('aps-environment') == environment,
            'APNs signature and provisioning environment mismatch')
    return {'signedEnvironment': environment,
            'registrationEnvironment': 'sandbox' if environment == 'development' else 'prod'}


def certificate_pin(identity):
    require('signingCertificateSha1' not in identity,
            'Legacy signingCertificateSha1: migrate the trusted certificate to signingCertificateSha256 and prepare a new build')
    pin = identity.get('signingCertificateSha256')
    require(isinstance(pin, str) and re.fullmatch(r'[A-Fa-f0-9]{64}', pin),
            'Invalid signingCertificateSha256: expected 64 hex characters')
    return pin.upper()


def verify_certificate(cert, authorized_certificates, identity):
    require(hashlib.sha256(cert).hexdigest().upper() == certificate_pin(identity), 'Certificate mismatch')
    require(cert in authorized_certificates, 'Certificate not authorized by profile')


def export_options(identity):
    require(identity.get('distribution') == 'ad-hoc', 'Export requires ad-hoc distribution')
    options = {'method': 'release-testing', 'destination': 'export', 'teamID': identity['teamId'],
               'signingStyle': 'automatic', 'manageAppVersionAndBuildNumber': False}
    if 'exportProvisioningProfiles' in identity:
        profiles = identity['exportProvisioningProfiles']
        bundle = identity['bundleId']
        expected = {bundle, *(bundle + '.' + suffix for suffix in
                    ['CindyNotificationService', 'CindyHomeWidgets', 'expo-sharing-extension'])}
        require(isinstance(profiles, dict) and set(profiles) == expected and
                all(isinstance(v, str) and 0 < len(v.strip()) <= len(v) <= 200 and
                    not re.search(r'[\x00-\x1f\x7f]', v) for v in profiles.values()),
                'Export requires profiles for exactly the main app and three extensions')
        options.update(signingStyle='manual', signingCertificate='Apple Distribution',
                       provisioningProfiles=profiles)
    return options


def extract_export(directory):
    archives = list(directory.glob('*.ipa'))
    require(len(archives) == 1, 'Expected one exported IPA')
    destination = directory / 'unpacked'
    require(not destination.exists(), 'Export extraction must use a fresh directory')
    with zipfile.ZipFile(archives[0]) as archive:
        for entry in archive.infolist():
            name = pathlib.PurePosixPath(entry.filename)
            require(not name.is_absolute() and '..' not in name.parts and '\\' not in entry.filename,
                    'Unsafe exported archive path')
            mode = entry.external_attr >> 16
            require(not stat.S_ISLNK(mode) and stat.S_IFMT(mode) in [0, stat.S_IFREG, stat.S_IFDIR],
                    'Unexpected exported archive entry')
        archive.extractall(destination)
        # zipfile does not preserve executable bits; the device installer needs them.
        for entry in archive.infolist():
            mode = (entry.external_attr >> 16) & 0o777
            if mode:
                (destination / entry.filename).chmod(mode)


def verify_distribution(identity, entitlements, profile, main=False):
    mode = identity.get('distribution', 'development')
    require(mode in ['development', 'ad-hoc'], 'Invalid mobile distribution')
    if mode == 'ad-hoc':
        require(entitlements.get('get-task-allow') is False and
                profile['Entitlements'].get('get-task-allow') is False, 'Ad Hoc package permits debugging')
        require(not profile.get('ProvisionsAllDevices'), 'Enterprise profile is not Ad Hoc')
    if main:
        proof = verify_push_environment(entitlements, profile['Entitlements'])
        expected = 'production' if mode == 'ad-hoc' else 'development'
        require(proof['signedEnvironment'] == expected, 'APNs environment does not match requested distribution')


def verify(request, app):
    identity = request['identity']
    certificate_pin(identity)  # Reject legacy requests before inspecting any candidate.
    main_id, team = identity['bundleId'], identity['teamId']
    expected = {main_id, main_id + '.CindyHomeWidgets', main_id + '.CindyNotificationService',
                main_id + '.expo-sharing-extension'}
    output('codesign', '--verify', '--deep', '--strict', str(app))
    results = []
    for entry in [app] + sorted((app / 'PlugIns').glob('*.appex')):
        # A main-app deep check alone missed an extension's replaced provisioning file in Xcode.
        output('codesign', '--verify', '--strict', str(entry))
        info = plist(entry / 'Info.plist')
        bundle = info['CFBundleIdentifier']
        require(bundle in expected, 'Unexpected bundle: ' + bundle)
        require(info['CFBundleVersion'] == request['build'], 'Bundle version mismatch: ' + bundle)
        ent = plistlib.loads(output('codesign', '-d', '--entitlements', ':-', str(entry)))
        profile = plistlib.loads(output('security', 'cms', '-D', '-i', str(entry / 'embedded.mobileprovision')))
        verify_distribution(identity, ent, profile, main=entry == app)
        require(identity['hardwareUdid'] in profile.get('ProvisionedDevices', []), bundle + ' excludes target device')
        require(profile['ExpirationDate'] > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), 'Expired profile')
        require(ent['application-identifier'] == team + '.' + bundle, 'Application identifier mismatch')
        require(ent['com.apple.developer.team-identifier'] == team, 'Team mismatch')
        for key, value in ent.items():
            require(key in profile['Entitlements'] and allows(value, profile['Entitlements'][key]), 'Unauthorized entitlement: ' + key)
        with tempfile.TemporaryDirectory(prefix='cindy-public-certificate-') as temp:
            prefix = str(pathlib.Path(temp) / 'cert')
            output('codesign', '-d', '--extract-certificates=' + prefix, str(entry))
            cert = pathlib.Path(prefix + '0').read_bytes()
            verify_certificate(cert, profile['DeveloperCertificates'], identity)
        if bundle != main_id + '.CindyNotificationService':
            group = identity['appGroupId']
            require(ent.get('com.apple.security.application-groups') == [group], 'App Group entitlement mismatch')
            key = 'ExpoShareIntoAppGroupId' if entry == app else ('CindyAppGroupId' if bundle.endswith('.CindyHomeWidgets') else 'AppGroupId')
            require(info.get(key) == group, 'App Group reader mismatch')
        else:
            require('com.apple.developer.usernotifications.communication' not in ent, 'Communication capability belongs on the main app')
        if entry == app:
            push_environment = verify_push_environment(ent, profile['Entitlements'])
            require(ent.get('com.apple.developer.usernotifications.communication') is True, 'Main app communication capability missing')
            require(info.get('CFBundleSupportedPlatforms') == ['iPhoneOS'], 'Not a physical iPhone build')
        results.append({'bundleId': bundle, 'build': info['CFBundleVersion'], 'deviceAuthorized': True,
                        'profileExpires': profile['ExpirationDate'].isoformat()})
    require(len(results) == 4 and {v['bundleId'] for v in results} == expected, 'Missing or duplicate extension')
    updates = plist(app / 'Expo.plist')
    require(updates.get('EXUpdatesEnabled') is False, 'Personal device delivery must not enable OTA implicitly')
    require((app / 'main.jsbundle').stat().st_size > 0, 'Missing embedded JavaScript bundle')
    digest = hashlib.sha256()
    for file in sorted(app.rglob('*')):
        require(not file.is_symlink(), 'Unexpected artifact symlink')
        if file.is_file():
            digest.update(str(file.relative_to(app)).encode() + b'\0')
            digest.update(hashlib.sha256(file.read_bytes()).digest())
    return {'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'bundles': results,
            'artifactHash': digest.hexdigest(), 'pushEnvironment': push_environment,
            'otaEnabled': False, 'fullInstalledByteMatchVerified': False}


if __name__ == '__main__':
    request = json.loads(pathlib.Path(sys.argv[2]).read_text())
    if sys.argv[1] == 'configure':
        configure(request)
    elif sys.argv[1] == 'verify':
        print(json.dumps(verify(request, pathlib.Path(sys.argv[3]))))
    elif sys.argv[1] == 'export-options':
        pathlib.Path(sys.argv[3]).write_bytes(plistlib.dumps(export_options(request['identity'])))
    elif sys.argv[1] == 'extract-export':
        extract_export(pathlib.Path(sys.argv[3]))
    else:
        raise RuntimeError('Unknown native mobile command')
