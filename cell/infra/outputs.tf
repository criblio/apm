output "public_ip" {
  description = "Elastic IP of the cell node — point the domain's A record here."
  value       = aws_eip.cell.public_ip
}

output "bucket" {
  description = "Fleet bucket (deploy target for `celld deploy`)."
  value       = aws_s3_bucket.fleet.bucket
}

output "instance_id" {
  description = "Instance id — shell in with: aws ssm start-session --target <id>"
  value       = aws_instance.cell.id
}

output "cell_url" {
  description = "Public base URL of the cell (once DNS points at the EIP)."
  value       = var.domain != "" ? "https://${var.domain}" : "(no domain set — HTTP dev mode)"
}
