import { AcquisitionManager as Sdk } from "./acquisition-sdk";
import { Alert } from "./AlertAdapter";
import requestFetchAdapter from "./request-fetch-adapter";
import { AppState, Platform } from "react-native";
import RestartManager from "./RestartManager";
import log from "./logging";

let NativeGoby = require("react-native").NativeModules.Goby;
const PackageMixins = require("./package-mixins")(NativeGoby);

async function checkForUpdate(deploymentKey = null) {
  /*
   * Before we ask the server if an update exists, we
   * need to retrieve three pieces of information from the
   * native side: deployment key, app version (e.g. 1.0.1)
   * and the hash of the currently running update (if there is one).
   * This allows the client to only receive updates which are targetted
   * for their specific deployment and version and which are actually
   * different from the Goby update they have already installed.
   */
  const nativeConfig = await getConfiguration();

  /*
   * If a deployment key was explicitly provided,
   * then let's override the one we retrieved
   * from the native-side of the app. This allows
   * dynamically "redirecting" end-users at different
   * deployments (e.g. an early access deployment for insiders).
   */
  const config = deploymentKey ? { ...nativeConfig, ...{ deploymentKey } } : nativeConfig;
  const sdk = getPromisifiedSdk(requestFetchAdapter, config);

  // Use dynamically overridden getCurrentPackage() during tests.
  const localPackage = await module.exports.getCurrentPackage();

  /*
   * If the app has a previously installed update, and that update
   * was targetted at the same app version that is currently running,
   * then we want to use its package hash to determine whether a new
   * release has been made on the server. Otherwise, we only need
   * to send the app version to the server, since we are interested
   * in any updates for current app store version, regardless of hash.
   */
  let queryPackage;
  if (localPackage) {
    queryPackage = localPackage;
  } else {
    queryPackage = { appVersion: config.appVersion };
    if (Platform.OS === "ios" && config.packageHash) {
      queryPackage.packageHash = config.packageHash;
    }
  }

  const update = await sdk.queryUpdateWithCurrentPackage(queryPackage);

  /*
   * There are four cases where checkForUpdate will resolve to null:
   * ----------------------------------------------------------------
   * 1) The server said there isn't an update. This is the most common case.
   * 2) The server said there is an update but it requires a newer binary version.
   *    This would occur when end-users are running an older app store version than
   *    is available, and Goby is making sure they don't get an update that
   *    potentially wouldn't be compatible with what they are running.
   * 3) The server said there is an update, but the update's hash is the same as
   *    the currently running update. This should _never_ happen, unless there is a
   *    bug in the server, but we're adding this check just to double-check that the
   *    client app is resilient to a potential issue with the update check.
   * 4) The server said there is an update, but the update's hash is the same as that
   *    of the binary's currently running version. This should only happen in Android -
   *    unlike iOS, we don't attach the binary's hash to the updateCheck request
   *    because we want to avoid having to install diff updates against the binary's
   *    version, which we can't do yet on Android.
   */
  if (!update || update.updateAppVersion ||
      localPackage && (update.packageHash === localPackage.packageHash) ||
      (!localPackage || localPackage._isDebugOnly) && config.packageHash === update.packageHash) {
    if (update && update.updateAppVersion) {
      log("An update is available but it is not targeting the binary version of your app.");
    }

    return null;
  } else {
    const remotePackage = { ...update, ...PackageMixins.remote(sdk.reportStatusDownload) };
    remotePackage.failedInstall = await NativeGoby.isFailedUpdate(remotePackage.packageHash);
    remotePackage.deploymentKey = deploymentKey || nativeConfig.deploymentKey;
    return remotePackage;
  }
}

const getConfiguration = (() => {
  let config;
  return async function getConfiguration() {
    if (config) {
      return config;
    } else if (testConfig) {
      return testConfig;
    } else {
      config = await NativeGoby.getConfiguration();
      return config;
    }
  }
})();

async function getCurrentPackage() {
  return await getUpdateMetadata(Goby.UpdateState.LATEST);
}

async function getUpdateMetadata(updateState) {
  let updateMetadata = await NativeGoby.getUpdateMetadata(updateState || Goby.UpdateState.RUNNING);
  if (updateMetadata) {
    updateMetadata = {...PackageMixins.local, ...updateMetadata};
    updateMetadata.failedInstall = await NativeGoby.isFailedUpdate(updateMetadata.packageHash);
    updateMetadata.isFirstRun = await NativeGoby.isFirstRun(updateMetadata.packageHash);
  }
  return updateMetadata;
}

function getPromisifiedSdk(requestFetchAdapter, config) {
  // Use dynamically overridden AcquisitionSdk during tests.
  const sdk = new module.exports.AcquisitionSdk(requestFetchAdapter, config);
  sdk.queryUpdateWithCurrentPackage = (queryPackage) => {
    return new Promise((resolve, reject) => {
      module.exports.AcquisitionSdk.prototype.queryUpdateWithCurrentPackage.call(sdk, queryPackage, (err, update) => {
        if (err) {
          reject(err);
        } else {
          resolve(update);
        }
      });
    });
  };

  sdk.reportStatusDeploy = (deployedPackage, status, previousLabelOrAppVersion, previousDeploymentKey) => {
    return new Promise((resolve, reject) => {
      module.exports.AcquisitionSdk.prototype.reportStatusDeploy.call(sdk, deployedPackage, status, previousLabelOrAppVersion, previousDeploymentKey, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  };

  sdk.reportStatusDownload = (downloadedPackage) => {
    return new Promise((resolve, reject) => {
      module.exports.AcquisitionSdk.prototype.reportStatusDownload.call(sdk, downloadedPackage, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  };

  return sdk;
}

// This ensures that notifyApplicationReadyInternal is only called once
// in the lifetime of this module instance.
const notifyApplicationReady = (() => {
  let notifyApplicationReadyPromise;
  return () => {
    if (!notifyApplicationReadyPromise) {
      notifyApplicationReadyPromise = notifyApplicationReadyInternal();
    }

    return notifyApplicationReadyPromise;
  };
})();

async function notifyApplicationReadyInternal() {
  await NativeGoby.notifyApplicationReady();
  const statusReport = await NativeGoby.getNewStatusReport();
  statusReport && tryReportStatus(statusReport); // Don't wait for this to complete.

  return statusReport;
}

async function tryReportStatus(statusReport, resumeListener) {
  const config = await getConfiguration();
  const previousLabelOrAppVersion = statusReport.previousLabelOrAppVersion;
  const previousDeploymentKey = statusReport.previousDeploymentKey || config.deploymentKey;
  try {
    if (statusReport.appVersion) {
      log(`Reporting binary update (${statusReport.appVersion})`);

      const sdk = getPromisifiedSdk(requestFetchAdapter, config);
      await sdk.reportStatusDeploy(/* deployedPackage */ null, /* status */ null, previousLabelOrAppVersion, previousDeploymentKey);
    } else {
      const label = statusReport.package.label;
      if (statusReport.status === "DeploymentSucceeded") {
        log(`Reporting Goby update success (${label})`);
      } else {
        log(`Reporting Goby update rollback (${label})`);
      }

      config.deploymentKey = statusReport.package.deploymentKey;
      const sdk = getPromisifiedSdk(requestFetchAdapter, config);
      await sdk.reportStatusDeploy(statusReport.package, statusReport.status, previousLabelOrAppVersion, previousDeploymentKey);
    }

    NativeGoby.recordStatusReported(statusReport);
    resumeListener && AppState.removeEventListener("change", resumeListener);
  } catch (e) {
    log(`Report status failed: ${JSON.stringify(statusReport)}`);
    NativeGoby.saveStatusReportForRetry(statusReport);
    // Try again when the app resumes
    if (!resumeListener) {
      resumeListener = async (newState) => {
        if (newState !== "active") return;
        const refreshedStatusReport = await NativeGoby.getNewStatusReport();
        if (refreshedStatusReport) {
          tryReportStatus(refreshedStatusReport, resumeListener);
        } else {
          AppState.removeEventListener("change", resumeListener);
        }
      };
      AppState.addEventListener("change", resumeListener);
    }
  }
}

var testConfig;

// This function is only used for tests. Replaces the default SDK, configuration and native bridge
function setUpTestDependencies(testSdk, providedTestConfig, testNativeBridge) {
  if (testSdk) module.exports.AcquisitionSdk = testSdk;
  if (providedTestConfig) testConfig = providedTestConfig;
  if (testNativeBridge) NativeGoby = testNativeBridge;
}

// This function allows only one syncInternal operation to proceed at any given time.
// Parallel calls to sync() while one is ongoing yields Goby.SyncStatus.SYNC_IN_PROGRESS.
const sync = (() => {
  let syncInProgress = false;
  const setSyncCompleted = () => { syncInProgress = false; };

  return (options = {}, syncStatusChangeCallback, downloadProgressCallback) => {
    if (syncInProgress) {
      typeof syncStatusChangeCallback === "function"
        ? syncStatusChangeCallback(Goby.SyncStatus.SYNC_IN_PROGRESS)
        : log("Sync already in progress.");
      return Promise.resolve(Goby.SyncStatus.SYNC_IN_PROGRESS);
    }

    syncInProgress = true;
    const syncPromise = syncInternal(options, syncStatusChangeCallback, downloadProgressCallback);
    syncPromise
      .then(setSyncCompleted)
      .catch(setSyncCompleted);

    return syncPromise;
  };
})();

/*
 * The syncInternal method provides a simple, one-line experience for
 * incorporating the check, download and installation of an update.
 *
 * It simply composes the existing API methods together and adds additional
 * support for respecting mandatory updates, ignoring previously failed
 * releases, and displaying a standard confirmation UI to the end-user
 * when an update is available.
 */
async function syncInternal(options = {}, syncStatusChangeCallback, downloadProgressCallback) {
  let resolvedInstallMode;
  const syncOptions = {
    deploymentKey: null,
    ignoreFailedUpdates: true,
    installMode: Goby.InstallMode.ON_NEXT_RESTART,
    mandatoryInstallMode: Goby.InstallMode.IMMEDIATE,
    minimumBackgroundDuration: 0,
    updateDialog: null,
    ...options
  };

  syncStatusChangeCallback = typeof syncStatusChangeCallback === "function"
    ? syncStatusChangeCallback
    : (syncStatus) => {
        switch(syncStatus) {
          case Goby.SyncStatus.CHECKING_FOR_UPDATE:
            log("Checking for update.");
            break;
          case Goby.SyncStatus.AWAITING_USER_ACTION:
            log("Awaiting user action.");
            break;
          case Goby.SyncStatus.DOWNLOADING_PACKAGE:
            log("Downloading package.");
            break;
          case Goby.SyncStatus.INSTALLING_UPDATE:
            log("Installing update.");
            break;
          case Goby.SyncStatus.UP_TO_DATE:
            log("App is up to date.");
            break;
          case Goby.SyncStatus.UPDATE_IGNORED:
            log("User cancelled the update.");
            break;
          case Goby.SyncStatus.UPDATE_INSTALLED:
            if (resolvedInstallMode == Goby.InstallMode.ON_NEXT_RESTART) {
              log("Update is installed and will be run on the next app restart.");
            } else if (resolvedInstallMode == Goby.InstallMode.ON_NEXT_RESUME) {
              if (syncOptions.minimumBackgroundDuration > 0) {
                log(`Update is installed and will be run after the app has been in the background for at least ${syncOptions.minimumBackgroundDuration} seconds.`);
              } else {
                log("Update is installed and will be run when the app next resumes.");
              }
            }
            break;
          case Goby.SyncStatus.UNKNOWN_ERROR:
            log("An unknown error occurred.");
            break;
        }
      };

  try {
    await Goby.notifyApplicationReady();

    syncStatusChangeCallback(Goby.SyncStatus.CHECKING_FOR_UPDATE);
    const remotePackage = await checkForUpdate(syncOptions.deploymentKey);

    const doDownloadAndInstall = async () => {
      syncStatusChangeCallback(Goby.SyncStatus.DOWNLOADING_PACKAGE);
      const localPackage = await remotePackage.download(downloadProgressCallback);

      // Determine the correct install mode based on whether the update is mandatory or not.
      resolvedInstallMode = localPackage.isMandatory ? syncOptions.mandatoryInstallMode : syncOptions.installMode;

      syncStatusChangeCallback(Goby.SyncStatus.INSTALLING_UPDATE);
      await localPackage.install(resolvedInstallMode, syncOptions.minimumBackgroundDuration, () => {
        syncStatusChangeCallback(Goby.SyncStatus.UPDATE_INSTALLED);
      });

      return Goby.SyncStatus.UPDATE_INSTALLED;
    };

    const updateShouldBeIgnored = remotePackage && (remotePackage.failedInstall && syncOptions.ignoreFailedUpdates);
    if (!remotePackage || updateShouldBeIgnored) {
      if (updateShouldBeIgnored) {
          log("An update is available, but it is being ignored due to having been previously rolled back.");
      }

      const currentPackage = await Goby.getCurrentPackage();
      if (currentPackage && currentPackage.isPending) {
        syncStatusChangeCallback(Goby.SyncStatus.UPDATE_INSTALLED);
        return Goby.SyncStatus.UPDATE_INSTALLED;
      } else {
        syncStatusChangeCallback(Goby.SyncStatus.UP_TO_DATE);
        return Goby.SyncStatus.UP_TO_DATE;
      }
    } else if (syncOptions.updateDialog) {
      // updateDialog supports any truthy value (e.g. true, "goo", 12),
      // but we should treat a non-object value as just the default dialog
      if (typeof syncOptions.updateDialog !== "object") {
        syncOptions.updateDialog = Goby.DEFAULT_UPDATE_DIALOG;
      } else {
        syncOptions.updateDialog = { ...Goby.DEFAULT_UPDATE_DIALOG, ...syncOptions.updateDialog };
      }

      return await new Promise((resolve, reject) => {
        let message = null;
        const dialogButtons = [{
          text: null,
          onPress:() => {
            doDownloadAndInstall()
              .then(resolve, reject);
          }
        }];

        if (remotePackage.isMandatory) {
          message = syncOptions.updateDialog.mandatoryUpdateMessage;
          dialogButtons[0].text = syncOptions.updateDialog.mandatoryContinueButtonLabel;
        } else {
          message = syncOptions.updateDialog.optionalUpdateMessage;
          dialogButtons[0].text = syncOptions.updateDialog.optionalInstallButtonLabel;
          // Since this is an optional update, add another button
          // to allow the end-user to ignore it
          dialogButtons.push({
            text: syncOptions.updateDialog.optionalIgnoreButtonLabel,
            onPress: () => {
              syncStatusChangeCallback(Goby.SyncStatus.UPDATE_IGNORED);
              resolve(Goby.SyncStatus.UPDATE_IGNORED);
            }
          });
        }

        // If the update has a description, and the developer
        // explicitly chose to display it, then set that as the message
        if (syncOptions.updateDialog.appendReleaseDescription && remotePackage.description) {
          message += `${syncOptions.updateDialog.descriptionPrefix} ${remotePackage.description}`;
        }

        syncStatusChangeCallback(Goby.SyncStatus.AWAITING_USER_ACTION);
        Alert.alert(syncOptions.updateDialog.title, message, dialogButtons);
      });
    } else {
      return await doDownloadAndInstall();
    }
  } catch (error) {
    syncStatusChangeCallback(Goby.SyncStatus.UNKNOWN_ERROR);
    log(error.message);
    throw error;
  }
};

let Goby;

function gobify(options = {}) {
  let React;
  let ReactNative = require("react-native");

  try { React = require("react"); } catch (e) { }
  if (!React) {
    try { React = ReactNative.React; } catch (e) { }
    if (!React) {
      throw new Error("Unable to find the 'React' module.");
    }
  }

  if (!React.Component) {
    throw new Error(
`Unable to find the "Component" class, please either:
1. Upgrade to a newer version of React Native that supports it, or
2. Call the goby.sync API in your component instead of using the @goby decorator`
    );
  }

  var decorator = (RootComponent) => {
    return class GobyComponent extends React.Component {
      componentDidMount() {
        if (options.checkFrequency === Goby.CheckFrequency.MANUAL) {
          Goby.notifyAppReady();
        } else {
          let rootComponentInstance = this.refs.rootComponent;

          let syncStatusCallback;
          if (rootComponentInstance && rootComponentInstance.gobyStatusDidChange) {
            syncStatusCallback = rootComponentInstance.gobyStatusDidChange;
            if (rootComponentInstance instanceof React.Component) {
              syncStatusCallback = syncStatusCallback.bind(rootComponentInstance);
            }
          }

          let downloadProgressCallback;
          if (rootComponentInstance && rootComponentInstance.gobyDownloadDidProgress) {
            downloadProgressCallback = rootComponentInstance.gobyDownloadDidProgress;
            if (rootComponentInstance instanceof React.Component) {
              downloadProgressCallback = downloadProgressCallback.bind(rootComponentInstance);
            }
          }

          Goby.sync(options, syncStatusCallback, downloadProgressCallback);
          if (options.checkFrequency === Goby.CheckFrequency.ON_APP_RESUME) {
            ReactNative.AppState.addEventListener("change", (newState) => {
              newState === "active" && Goby.sync(options, syncStatusCallback, downloadProgressCallback);
            });
          }
        }
      }

      render() {
        return <RootComponent {...this.props} ref={"rootComponent"} />
      }
    }
  }

  if (typeof options === "function") {
    // Infer that the root component was directly passed to us.
    return decorator(options);
  } else {
    return decorator;
  }
}

// If the "NativeGoby" variable isn't defined, then
// the app didn't properly install the native module,
// and therefore, it doesn't make sense initializing
// the JS interface when it wouldn't work anyways.
if (NativeGoby) {
  Goby = gobify;
  Object.assign(Goby, {
    AcquisitionSdk: Sdk,
    checkForUpdate,
    getConfiguration,
    getCurrentPackage,
    getUpdateMetadata,
    log,
    notifyAppReady: notifyApplicationReady,
    notifyApplicationReady,
    restartApp: RestartManager.restartApp,
    setUpTestDependencies,
    sync,
    disallowRestart: RestartManager.disallow,
    allowRestart: RestartManager.allow,
    InstallMode: {
      IMMEDIATE: NativeGoby.gobyInstallModeImmediate, // Restart the app immediately
      ON_NEXT_RESTART: NativeGoby.gobyInstallModeOnNextRestart, // Don't artificially restart the app. Allow the update to be "picked up" on the next app restart
      ON_NEXT_RESUME: NativeGoby.gobyInstallModeOnNextResume, // Restart the app the next time it is resumed from the background
      ON_NEXT_SUSPEND: NativeGoby.gobyInstallModeOnNextSuspend // Restart the app _while_ it is in the background,
      // but only after it has been in the background for "minimumBackgroundDuration" seconds (0 by default),
      // so that user context isn't lost unless the app suspension is long enough to not matter
    },
    SyncStatus: {
      UP_TO_DATE: 0, // The running app is up-to-date
      UPDATE_INSTALLED: 1, // The app had an optional/mandatory update that was successfully downloaded and is about to be installed.
      UPDATE_IGNORED: 2, // The app had an optional update and the end-user chose to ignore it
      UNKNOWN_ERROR: 3,
      SYNC_IN_PROGRESS: 4, // There is an ongoing "sync" operation in progress.
      CHECKING_FOR_UPDATE: 5,
      AWAITING_USER_ACTION: 6,
      DOWNLOADING_PACKAGE: 7,
      INSTALLING_UPDATE: 8
    },
    CheckFrequency: {
      ON_APP_START: 0,
      ON_APP_RESUME: 1,
      MANUAL: 2
    },
    UpdateState: {
      RUNNING: NativeGoby.gobyUpdateStateRunning,
      PENDING: NativeGoby.gobyUpdateStatePending,
      LATEST: NativeGoby.gobyUpdateStateLatest
    },
    DeploymentStatus: {
      FAILED: "DeploymentFailed",
      SUCCEEDED: "DeploymentSucceeded",
    },
    DEFAULT_UPDATE_DIALOG: {
      appendReleaseDescription: false,
      descriptionPrefix: " Description: ",
      mandatoryContinueButtonLabel: "Continue",
      mandatoryUpdateMessage: "An update is available that must be installed.",
      optionalIgnoreButtonLabel: "Ignore",
      optionalInstallButtonLabel: "Install",
      optionalUpdateMessage: "An update is available. Would you like to install it?",
      title: "Update available"
    }
  });
} else {
  log("The Goby module doesn't appear to be properly installed. Please double-check that everything is setup correctly.");
}

module.exports = Goby;