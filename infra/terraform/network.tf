# Minimal public-subnet VPC. Two AZs because that's the ALB minimum; the
# Fargate service runs in either of them (whichever has free capacity).
# No private subnets, no NAT gateway — the controller's outbound traffic
# (OpenAI, Google OAuth) all goes via the IGW, free.

resource "aws_vpc" "main" {
  cidr_block           = local.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = {
    Name = "${local.service_name}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags = {
    Name = "${local.service_name}-igw"
  }
}

resource "aws_subnet" "public" {
  count                   = length(local.public_subnets)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = local.public_subnets[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags = {
    Name = "${local.service_name}-public-${local.azs[count.index]}"
    Tier = "public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = {
    Name = "${local.service_name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Security groups. The split is the standard one:
#   alb -> world on 80/443 (we redirect 80 → 443 at the listener)
#   task -> alb on the container port; egress to anywhere for OpenAI etc.
resource "aws_security_group" "alb" {
  name        = "${local.service_name}-alb"
  description = "ALB ingress from the internet on 80/443"
  vpc_id      = aws_vpc.main.id

  ingress {
    description      = "HTTPS"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
  ingress {
    description      = "HTTP (redirected to HTTPS)"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
  egress {
    description      = "All outbound"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

resource "aws_security_group" "task" {
  name        = "${local.service_name}-task"
  description = "Fargate task: ALB → 3737 only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Controller port from ALB"
    from_port       = local.container_port
    to_port         = local.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    description      = "All outbound (OpenAI, Google OAuth, agent WS, etc.)"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}
