import { configureProjectDirectoryProbe } from './projectDirectoryValidation.js';
import { probeRemoteWorkingDirectory } from './remote-ssh/index.js';

configureProjectDirectoryProbe(probeRemoteWorkingDirectory);
