# Investigator cell on AWS: one celld node + one S3 bucket.
#
# Deliberately minimal — celld's own design carries the durability
# (every cell's SQLite replicates to the bucket; nodes are stateless
# and replaceable), so the instance is disposable by construction.
# Scale-out later = more instances pointed at the same bucket.

# ── Fleet bucket ─────────────────────────────────────────────────

resource "aws_s3_bucket" "fleet" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "fleet" {
  bucket                  = aws_s3_bucket.fleet.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "fleet" {
  bucket = aws_s3_bucket.fleet.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ── Instance role: bucket + SSM only, no SSH keys ────────────────

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cell" {
  name               = "apm-cell-node"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "cell" {
  statement {
    sid       = "FleetBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.fleet.arn]
  }
  statement {
    sid       = "FleetBucketObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.fleet.arn}/*"]
  }
  statement {
    sid       = "ReadCellSecrets"
    actions   = ["ssm:GetParameter", "ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${var.region}:*:parameter${var.ssm_parameter_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "cell" {
  name   = "apm-cell-node"
  role   = aws_iam_role.cell.id
  policy = data.aws_iam_policy_document.cell.json
}

# Session Manager instead of SSH — no port 22, no key management.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.cell.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "cell" {
  name = "apm-cell-node"
  role = aws_iam_role.cell.name
}

# ── Network ──────────────────────────────────────────────────────

data "aws_vpc" "default" {
  default = true
}

resource "aws_security_group" "cell" {
  name        = "apm-cell-node"
  description = "Investigator cell: HTTPS in (Cribl webhooks + platform proxy), no SSH (use SSM Session Manager)."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTPS (Caddy)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTP (ACME challenges + redirect)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ── Node ─────────────────────────────────────────────────────────

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "cell" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  iam_instance_profile   = aws_iam_instance_profile.cell.name
  vpc_security_group_ids = [aws_security_group.cell.id]

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    bucket        = aws_s3_bucket.fleet.bucket
    region        = var.region
    celld_version = var.celld_version
    domain        = var.domain
    ssm_prefix    = var.ssm_parameter_prefix
  })
  # user_data changes replace the instance — safe: all durable state
  # lives in the bucket (verified in the S2 spike).
  user_data_replace_on_change = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  tags = { Name = "apm-cell-node" }
}

resource "aws_eip" "cell" {
  instance = aws_instance.cell.id
  domain   = "vpc"
}
