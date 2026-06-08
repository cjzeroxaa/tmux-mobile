# Deploying the controller to AWS Fargate

Walks through the one-time setup that puts `server.mjs --controller` behind
**https://eng.rebyte.ai**. Re-runs after a code change collapse to two commands
(see [Routine redeploy](#routine-redeploy) at the bottom).

## Architecture

```
phone ── HTTPS ──► eng.rebyte.ai (Google Cloud DNS)
                       │ CNAME
                       ▼
                   ALB :443 (HTTPS, ACM cert)
                       │
                       ▼
                  Fargate task (ARM64, 0.25 vCPU / 0.5 GB)
                  └── node server.mjs --controller
                      ├── secrets from AWS Secrets Manager
                      ├── outbound WS ← agents (`node server.mjs --register …`)
                      └── HTTPS → OpenAI, Google OAuth
```

Single-AZ public subnets (ALB needs ≥2 AZs; the task itself runs in one).
No NAT — task gets a public IP, talks to the internet via the IGW.

## What you need

- AWS credentials with rights to: VPC, ALB, ACM, ECR, ECS, IAM,
  Secrets Manager, CloudWatch Logs. The existing `rebyte-prod` IAM user
  fits.
- `terraform >= 1.5`, `docker` with buildx, `aws cli`.
- `gcloud` auth'd against the project that owns the `rebyte-ai` DNS zone
  (for adding the ACM validation CNAME and the eng.rebyte.ai CNAME).
- The seven values that the controller refuses to start without:
  `OPENAI_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `GOOGLE_DEVICE_CLIENT_ID`, `GOOGLE_DEVICE_CLIENT_SECRET`,
  `SESSION_SECRET` (auto-generated for you), and at least one of
  `ALLOWED_GOOGLE_EMAILS` / `ALLOWED_GOOGLE_DOMAINS` (set in TF vars,
  default `sonicgg@gmail.com` + `rebyte.ai`).

## First-time deploy

### 1. Provision the AWS-side infra

```bash
cd infra/terraform
terraform init
terraform apply -target=aws_acm_certificate.controller
```

The `-target` is intentional: ACM only emits the validation CNAME
*after* the cert request resource is created. The cert will be PENDING
at this point — the next step makes it ISSUED.

### 2. Add the ACM validation CNAME to Google Cloud DNS

Pull the gcloud command Terraform already wrote out:

```bash
terraform output -raw gcloud_dns_validation_cmd
```

It prints something like:

```
gcloud dns record-sets create _abc123.eng.rebyte.ai --zone=rebyte-ai --type=CNAME --ttl=300 --rrdatas='_xyz.acm-validations.aws.'
# After the cert validates (re-run `terraform apply`), point the domain at the ALB:
gcloud dns record-sets create eng.rebyte.ai. --zone=rebyte-ai --type=CNAME --ttl=300 --rrdatas='<alb-dns-name>.'
```

Run **only the first line** for now (the validation CNAME). The second is for step 4.

### 3. Full apply

Now ACM can validate. Run the rest:

```bash
terraform apply
```

This blocks on `aws_acm_certificate_validation.controller` until ACM sees
the CNAME (usually <2 min, occasionally up to 10). Then it builds the
ALB, ECS cluster, task definition, service, and Secrets Manager entries.

The Fargate service tries to start a task and **will fail** because the
secrets are empty and there's no image in ECR yet. That's expected — the
next two steps fix it.

### 4. Populate Secrets Manager

```bash
# Re-use the values from the Cloud Run controller's Secret Manager
# entries, or pull from 1Password.
aws secretsmanager put-secret-value --secret-id tmux-mobile-controller/OPENAI_API_KEY              --secret-string '<key>'
aws secretsmanager put-secret-value --secret-id tmux-mobile-controller/GOOGLE_OAUTH_CLIENT_ID      --secret-string '<id>.apps.googleusercontent.com'
aws secretsmanager put-secret-value --secret-id tmux-mobile-controller/GOOGLE_OAUTH_CLIENT_SECRET  --secret-string '<secret>'
aws secretsmanager put-secret-value --secret-id tmux-mobile-controller/GOOGLE_DEVICE_CLIENT_ID     --secret-string '<id>.apps.googleusercontent.com'
aws secretsmanager put-secret-value --secret-id tmux-mobile-controller/GOOGLE_DEVICE_CLIENT_SECRET --secret-string '<secret>'
# SESSION_SECRET is auto-seeded with a 64-char random by TF; only overwrite
# if you want a specific value.
```

You also need to add the Fargate redirect URI to the Google OAuth client's
**Authorized redirect URIs** list:

```
https://eng.rebyte.ai/auth/google/callback
```

(via [console.cloud.google.com / API & Services / Credentials](https://console.cloud.google.com/apis/credentials))

### 5. Build + push the first image, point DNS

```bash
# From repo root:
./scripts/push-image.sh
```

This builds the linux/arm64 image, pushes it to ECR as
`<account>.dkr.ecr.us-east-1.amazonaws.com/tmux-mobile-controller:latest`
+ `:<git-sha>`, and forces the ECS service to redeploy.

Watch the task come up:

```bash
aws logs tail /ecs/tmux-mobile-controller --since 5m --follow --region us-east-1
```

Once it's logging `tmux controller listening at http://0.0.0.0:3737`, the
ALB target group will mark it healthy.

Verify on the ALB hostname directly (cert is signed for `eng.rebyte.ai`
but the ALB still answers on its own hostname; cert error in browser is
expected at this point):

```bash
ALB=$(cd infra/terraform && terraform output -raw alb_dns_name)
curl -k -sS -o /dev/null -w "HTTPS %{http_code}\n" "https://$ALB/api/health"
```

Expect `HTTPS 200`.

Now point eng.rebyte.ai at the ALB. The second line that
`gcloud_dns_validation_cmd` printed in step 2:

```bash
ALB=$(cd infra/terraform && terraform output -raw alb_dns_name)
gcloud dns record-sets create eng.rebyte.ai. --zone=rebyte-ai --type=CNAME --ttl=300 --rrdatas="${ALB}."
```

DNS propagates in ~30 s. Final check:

```bash
curl -sS -o /dev/null -w "HTTPS %{http_code}\n" https://eng.rebyte.ai/api/health
```

### 6. Register an agent against the new controller

On any Mac running tmux:

```bash
node server.mjs --register https://eng.rebyte.ai --login
```

The CLI walks you through the Google device-login flow and saves the
token to `~/.config/tmux-mobile/agent.json`. Subsequent restarts skip
the login.

## Routine redeploy

After the first deploy, code changes ship in two commands:

```bash
git push origin main
./scripts/push-image.sh
```

Roughly 90 seconds end-to-end:

- ~60 s to build the ARM64 image and push to ECR
- ~30 s for the ECS rolling deploy

## Costs (rough, us-east-1, on-demand)

| | / month |
|---|---|
| Fargate (0.25 vCPU + 0.5 GB ARM64, 1 task always-on) | ~$8 |
| ALB (baseline, no LCU traffic for single user) | ~$16 |
| ECR storage (1 GB) | $0.10 |
| CloudWatch Logs (low volume, 7 day retention) | <$1 |
| Secrets Manager (6 secrets × $0.40) | $2.40 |
| Data egress (low) | <$1 |
| **Total baseline** | **~$28** |

The ALB is the bulk of the cost. If single-user-only, an
ALB-less alternative is to give the Fargate task a public IP and put
Cloudflare in front for TLS — saves ~$16/month but reintroduces
Cloudflare as a dependency.

## Teardown

```bash
cd infra/terraform
terraform destroy
```

Plus, on Google Cloud DNS:

```bash
gcloud dns record-sets delete eng.rebyte.ai.       --zone=rebyte-ai --type=CNAME
gcloud dns record-sets delete _<acm-validation>... --zone=rebyte-ai --type=CNAME
```

Secrets Manager entries are recoverable for 7 days after `terraform
destroy` (see `recovery_window_in_days` in `secrets.tf`).
