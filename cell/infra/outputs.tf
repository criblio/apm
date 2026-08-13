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
  description = "Public base URL of the cell (auto-derived via sslip.io from the EIP)."
  value       = "https://${replace(aws_eip.cell.public_ip, ".", "-")}.sslip.io"
}
