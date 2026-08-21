# Re-exported from the fleet module so the documented commands
# (`terraform output -raw cell_url`, `instance_id` for SSM) keep
# working unchanged.

output "public_ip" {
  description = "Elastic IP of the cell node."
  value       = module.fleet.public_ip
}

output "bucket" {
  description = "Fleet bucket (deploy target for `celld deploy`)."
  value       = module.fleet.bucket
}

output "instance_id" {
  description = "Instance id — shell in with: aws ssm start-session --target <id>"
  value       = module.fleet.instance_id
}

output "cell_url" {
  description = "Public base URL of the cell (auto-derived via sslip.io from the EIP)."
  value       = module.fleet.cell_url
}
