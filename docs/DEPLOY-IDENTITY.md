# GitHub Actions deploy identity checklist

Draft for operator review, checked against the linked official documentation on 2026-10-19.
No Google Cloud resources, IAM bindings or GitHub environments have been created or inspected.
No deployment workflow is enabled by this document. Commands below are for an authorized
operator after the repository owner approves provisioning and, separately, deployment.

Use Workload Identity Federation (WIF) to impersonate a dedicated CI service account.
Keep deployment, build and runtime identities separate. This is a proposed configuration,
not a claim about an existing project. The service still lacks its production entrypoint;
see [deployment prerequisites](DEPLOY.md#4-three-things-in-this-repository-that-would-break-the-first-deploy).

## 1. Confirm the inputs and authority

- [ ] Owner selects the billing project, region and service name.
- [ ] Owner approves `main` as the deployment ref and a GitHub environment named `cloud-run`.
      This proposal follows the released-branch role of `main`; contributions still target `dev`.
- [ ] GitHub administrator confirms environment protection is available, restricts deployment
      branches to `main`, requires a reviewer and prevents self-review.
- [ ] Cloud administrator confirms permission to enable services, create service accounts,
      manage a WIF pool/provider, change project IAM and change service-account IAM.
      Relevant bootstrap roles include Service Usage Admin, Service Account Admin,
      Workload Identity Pool Admin and Project IAM Admin. These are operator permissions,
      not roles to grant the CI account. Existing custom roles may provide the same permissions.
- [ ] Use a dedicated pool for this trust relationship. If resources already exist, inspect
      and reconcile them; do not delete or recreate shared resources to make a command pass.

Run from an authorized operator's shell with `gcloud` and `gh` authenticated. Replace all
`REPLACE_` values first; keep the concrete project configuration in the operator's records.
This procedure assumes all Cloud resources are in the same project.

```bash
export PROJECT_ID='REPLACE_PROJECT_ID'
export REGION='REPLACE_REGION'
export SERVICE='venue-call-agent'
export REPO='creatorainco/venue-call-agent'
export POOL_ID='venue-call-github'
export PROVIDER_ID='release'
export DEPLOY_REF='refs/heads/main'
export GH_ENVIRONMENT='cloud-run'

export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export REPO_ID="$(gh api "repos/$REPO" --jq '.id')"
export OWNER_ID="$(gh api "repos/$REPO" --jq '.owner.id')"
export CI_SA="venue-call-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
export BUILD_SA="venue-call-build@${PROJECT_ID}.iam.gserviceaccount.com"
export RUNTIME_SA="venue-call-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
export POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
export PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER_ID}"
```

Verify that the project number, repository ID and owner ID are populated and refer to the
approved resources. Numeric GitHub IDs prevent a deleted repository or owner name being reused
to acquire trust. [Google federation guidance](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)

## 2. Enable APIs and create the identities

- [ ] Confirm billing is enabled and the region supports Cloud Build and Artifact Registry.
- [ ] Enable the required APIs, then create the dedicated service accounts.

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iam.googleapis.com cloudresourcemanager.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"

for account in venue-call-deploy venue-call-build venue-call-runtime; do
  gcloud iam service-accounts create "$account" --project="$PROJECT_ID"
done
```

The build identity below deliberately replaces the default Compute Engine build identity.
The runtime identity initially has no project roles; the operator must separately define any
runtime API or secret access when the service implementation needs it.

| Principal | Role | Resource receiving the binding |
|---|---|---|
| CI service account | `roles/run.admin` | Deployment project; action-documented baseline |
| CI service account | `roles/run.sourceDeveloper` | Deployment project; source-build permissions |
| CI service account | `roles/serviceusage.serviceUsageConsumer` | Deployment project |
| CI service account | `roles/iam.serviceAccountUser` | Build account and runtime account only |
| Build service account | `roles/run.builder` | Deployment project |
| Accepted GitHub identity | `roles/iam.workloadIdentityUser` | CI account only |

The source-deployment roles supplement the action's documented Run Admin role; Run Admin alone
is not the source-build permission set. This baseline is not a claim of minimal custom-role
permissions. The accounts receive neither Owner nor Editor.
[Source deployment roles](https://docs.cloud.google.com/run/docs/deploying-source-code),
[action authorization](https://github.com/google-github-actions/deploy-cloudrun#authorization),
[custom build account](https://docs.cloud.google.com/run/docs/configuring/services/build-service-account).

```bash
for role in roles/run.admin roles/run.sourceDeveloper roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${CI_SA}" --role="$role"
done

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/run.builder

for account in "$BUILD_SA" "$RUNTIME_SA"; do
  gcloud iam service-accounts add-iam-policy-binding "$account" --project="$PROJECT_ID" \
    --member="serviceAccount:${CI_SA}" --role=roles/iam.serviceAccountUser
done
```

## 3. Restrict federation and bind impersonation

- [ ] Create the dedicated pool and OIDC provider. This proposal accepts only manual runs on
      the approved ref, from the approved repository and owner, using the approved environment.
- [ ] Do not authorize a contributor fork, a pull-request event, or a pool-wide wildcard.

```bash
gcloud iam workload-identity-pools create "$POOL_ID" --project="$PROJECT_ID" \
  --location=global --display-name='Venue call release'

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
  --issuer-uri='https://token.actions.githubusercontent.com' \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name,attribute.environment=assertion.environment' \
  --attribute-condition="assertion.repository_owner_id == '${OWNER_ID}' && assertion.repository_id == '${REPO_ID}' && assertion.ref == '${DEPLOY_REF}' && assertion.event_name == 'workflow_dispatch' && assertion.environment == '${GH_ENVIRONMENT}'"

gcloud iam service-accounts add-iam-policy-binding "$CI_SA" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository_id/${REPO_ID}"
```

Allow time for IAM propagation before diagnosing failures. No service-account JSON key is
created. Standard WIF impersonation uses Workload Identity User; do not add Token Creator
as a blanket response to an authentication error.
[Authentication setup](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account).

## 4. Prepare GitHub configuration

An administrator configures the `cloud-run` environment in the upstream repository, with the
reviewer and branch restrictions agreed in step 1. Store these identifiers as environment
variables, using the GitHub settings UI; they are not credentials:

| GitHub variable | Operator value |
|---|---|
| `GCP_PROJECT_ID` | `$PROJECT_ID` |
| `GCP_REGION` | `$REGION` |
| `GCP_WIF_PROVIDER` | `$PROVIDER_NAME` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `$CI_SA` |
| `GCP_BUILD_SERVICE_ACCOUNT` | `$BUILD_SA` |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `$RUNTIME_SA` |
| `CLOUD_RUN_SERVICE` | `$SERVICE` |

Use `workflow_dispatch` only, a job restricted to the upstream repository and `refs/heads/main`,
`environment: cloud-run`, and job permissions `contents: read` and `id-token: write`.
The environment gate must apply to the job that authenticates, not just a later deploy job.
Do not grant an OIDC token to the existing PR verification job.
[GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc),
[environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

For a future workflow, preserve this order:

1. Checkout the approved release ref with `actions/checkout@v7`.
2. Use Node 22 and run the repository's verification, eval and simulated-call checks.
3. Authenticate using `google-github-actions/auth@v3`, with `project_id`,
   `workload_identity_provider` and `service_account` from the environment variables above.
4. Only after deployment approval, use `google-github-actions/deploy-cloudrun@v3` with
   `source: .`, the chosen service and region, and the flags below.

The example majors match the official action documentation checked for this draft. Resolve and
review immutable action commit pins before activating a deployment workflow.

```text
--service-account RUNTIME_SERVICE_ACCOUNT_EMAIL
--build-service-account projects/PROJECT_ID/serviceAccounts/BUILD_SERVICE_ACCOUNT_EMAIL
--update-build-env-vars GOOGLE_NODEJS_VERSION=22
--timeout 3600 --concurrency 1 --max-instances 5 --min 0 --cpu-throttling
```

Substitute the operator-approved values. The explicit build account and runtime account must
match the IAM bindings. Node selection is a build setting, not a runtime environment variable.
[Deploy flags](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy).

Before enabling this workflow, exclude `gha-creds-*.json` from Git, Docker contexts (if used)
and source uploads. Have the operator check `gcloud meta list-files-for-upload` against the
actual ignore configuration; the generated auth credential must not enter the build context.
Run checkout before auth and keep authentication close to the Cloud operations.
[Auth prerequisites](https://github.com/google-github-actions/auth#prerequisites).

New Cloud Run services are private by default; a revision deployment preserves existing access
policy. The operator must inspect IAM and invoker-check settings rather than treating a deploy
as proof of privacy. Leave public-invocation changes out of CI; carrier access is unresolved.
[Action access guidance](https://github.com/google-github-actions/deploy-cloudrun#allowing-unauthenticated-requests).

## 5. Verify each boundary before deployment

These checks require an authorized operator. They have not been executed for this draft.

```bash
gcloud services list --enabled --project="$PROJECT_ID"
gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
  --format='yaml(name,state,attributeMapping,attributeCondition,oidc)'
gcloud iam service-accounts get-iam-policy "$CI_SA" --project="$PROJECT_ID"
gcloud iam service-accounts get-iam-policy "$BUILD_SA" --project="$PROJECT_ID"
gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" --project="$PROJECT_ID"
gcloud projects get-iam-policy "$PROJECT_ID"
```

- [ ] Compare enabled APIs and IAM bindings with steps 2 and 3. Check effective inherited access
      as well as the explicit bindings; creating scoped grants does not remove older broad grants.
- [ ] Run an authentication-only workflow from the allowed ref and environment. After auth,
      use `gcloud run services list --project="$PROJECT_ID" --region="$REGION"`; expect success.
      Do not print tokens or credential files. This proves read authorization, not deploy success.
- [ ] Check rejection controls without a deploy step: a non-release ref, a PR event, a job
      without the approved environment, and a fork must not obtain the CI identity. Keep the
      production trust condition intact. If a GitHub gate blocks a run before OIDC, record that
      boundary as tested; it does not prove the provider condition was evaluated.
- [ ] Record the allowed result and rejection results in an operator record, with credentials
      removed. If any forbidden run authenticates, stop and correct the trust policy.
- [ ] Before a first deployment, confirm a production entrypoint exists, starts successfully,
      binds `0.0.0.0:$PORT`, and has reviewed runtime configuration. The mock is not that entrypoint.
- [ ] After an approved deployment, inspect revision readiness, build logs, the actual Node
      version, runtime service account, build identity, source-upload exclusions and invocation
      policy. A successful IAM check does not prove the application runs.

## 6. Decisions still awaiting the owner

The project and region, environment reviewer, release ref, runtime permissions, carrier access
and first-deployment timing remain unconfirmed. No project IDs or account credentials are
needed in this public document. Source research is complete enough to review this proposal;
provisioning, positive/negative authentication evidence and deployment evidence remain open.

For access revocation, the operator can remove this repository's Workload Identity User binding
or disable this dedicated provider. Existing issued credentials may remain valid until expiry;
revoking federation does not stop an already running service or roll back a deployment.
