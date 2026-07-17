import { ArrayDoc } from "./array-doc.js";
import { runConvergencePropertyTests, runDocContractTests } from "./doc-contract.test-helpers.js";

runDocContractTests("ArrayDoc (museum exhibit 2)", (replica) => new ArrayDoc(replica));
runConvergencePropertyTests("ArrayDoc (museum exhibit 2)", (replica) => new ArrayDoc(replica));
