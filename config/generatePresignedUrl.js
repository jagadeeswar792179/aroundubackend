const AWS = require("aws-sdk");
require("dotenv").config();

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Generate a temporary download link for private image
const generatePresignedUrl = (key) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Expires: 3600, // 1 hour expiry
  };

  return s3.getSignedUrl("getObject", params);
};

module.exports = generatePresignedUrl;
