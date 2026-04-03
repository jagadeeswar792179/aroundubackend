const AWS = require("aws-sdk");
require("dotenv").config();

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const CDN_URL = process.env.CLOUDFRONT_URL;

const generatePresignedUrl = (key) => {
  if (!key) return null;

  return `${CDN_URL}/${key}`;
};

module.exports = generatePresignedUrl;
